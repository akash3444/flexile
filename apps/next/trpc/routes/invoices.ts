import { TRPCError } from "@trpc/server";
import { formatISO } from "date-fns";
import { and, desc, eq, gte, inArray, isNull, lt, lte, not, notInArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { pick } from "lodash-es";
import { z } from "zod";
import { byExternalId, db, pagination, paginationSchema } from "@/db";
import {
  activeStorageAttachments,
  activeStorageBlobs,
  companies,
  companyContractors,
  invoiceApprovals,
  invoiceLineItems,
  invoices,
  users,
  wiseRecipients,
} from "@/db/schema";
import env from "@/env";
import { MAXIMUM_EQUITY_PERCENTAGE, MINIMUM_EQUITY_PERCENTAGE } from "@/models";
import { companyProcedure, createRouter, getS3Url } from "@/trpc";
import { sendEmail } from "@/trpc/email";
import { calculateInvoiceEquity } from "@/trpc/routes/equityCalculations";
import OneOffInvoiceCreated from "@/trpc/routes/OneOffInvoiceCreated";
import { latestUserComplianceInfo, simpleUser } from "@/trpc/routes/users";
import { assertDefined } from "@/utils/assert";

const actionableByUserInvoiceIds = async (userId: bigint, company: typeof companies.$inferSelect) => {
  const payableQuery = db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, company.id),
        inArray(invoices.status, ["approved", "failed"]),
        gte(invoices.invoiceApprovalsCount, company.requiredInvoiceApprovalCount),
        requiresAcceptanceByPayeeFilter ? not(requiresAcceptanceByPayeeFilter) : undefined,
      ),
    );

  const approvedInvoiceIds = await db.query.invoiceApprovals.findMany({
    columns: { invoiceId: true },
    where: eq(invoiceApprovals.approverId, userId),
  });

  const needsApprovalQuery = db
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, company.id),
        inArray(invoices.status, ["received", "approved", "failed"]),
        lt(invoices.invoiceApprovalsCount, company.requiredInvoiceApprovalCount),
        notInArray(
          invoices.id,
          approvedInvoiceIds.map((row) => row.invoiceId),
        ),
      ),
    );

  const result = await union(payableQuery, needsApprovalQuery);

  return result.map((row) => row.id);
};

const requiresAcceptanceByPayee = (
  invoice: Pick<typeof invoices.$inferSelect, "createdById" | "userId" | "acceptedAt">,
) => invoice.createdById !== invoice.userId && invoice.acceptedAt === null;

const requiresAcceptanceByPayeeFilter = and(
  not(eq(invoices.createdById, invoices.userId)),
  isNull(invoices.acceptedAt),
);

const INITIAL_ADMIN_INVOICE_NUMBER = "O-0001";
const getNextAdminInvoiceNumber = async (companyId: bigint, userId: bigint) => {
  const lastAdminInvoice = await db.query.invoices.findFirst({
    columns: { invoiceNumber: true },
    where: and(eq(invoices.companyId, companyId), eq(invoices.userId, userId), eq(invoices.invoiceType, "other")),
    orderBy: desc(invoices.invoiceNumber),
  });
  if (!lastAdminInvoice) return INITIAL_ADMIN_INVOICE_NUMBER;

  const digits = lastAdminInvoice.invoiceNumber.match(/\d+/gu)?.at(-1); // may include leading zeros
  if (!digits || parseInt(digits, 10) === 0) return INITIAL_ADMIN_INVOICE_NUMBER;

  const nextInvoiceId = parseInt(digits, 10) + 1;
  const paddedNextInvoiceId = nextInvoiceId.toString().padStart(digits.length, "0");

  // Only replace last occurrence of string (in case there are multiple occurrences, e.g. INV-001-001)
  return lastAdminInvoice.invoiceNumber
    .split("")
    .reverse()
    .join("")
    .replace(digits.split("").reverse().join(""), paddedNextInvoiceId.split("").reverse().join(""))
    .split("")
    .reverse()
    .join("");
};

const getFlexileFeeCents = (totalAmountCents: bigint) => {
  const BASE_FLEXILE_FEE_CENTS = 50n;
  const MAX_FLEXILE_FEE_CENTS = 1500n;
  const PERCENT_FLEXILE_FEE = 1.5;

  const feeCents = BASE_FLEXILE_FEE_CENTS + (totalAmountCents * BigInt(Math.round(PERCENT_FLEXILE_FEE * 100))) / 10000n;
  return feeCents > MAX_FLEXILE_FEE_CENTS ? MAX_FLEXILE_FEE_CENTS : feeCents;
};

const invoiceInputSchema = createInsertSchema(invoiceLineItems)
  .pick({
    description: true,
    totalAmountCents: true,
  })
  .extend({
    userExternalId: z.string(),
    ...createInsertSchema(invoices).pick({
      equityPercentage: true,
      minAllowedEquityPercentage: true,
      maxAllowedEquityPercentage: true,
    }).shape,
  })
  .refine(
    (data) =>
      !data.minAllowedEquityPercentage ||
      !data.maxAllowedEquityPercentage ||
      data.minAllowedEquityPercentage <= data.maxAllowedEquityPercentage,
    {
      message: "Minimum equity percentage must be less than or equal to maximum equity percentage",
    },
  )
  .refine(
    (data) =>
      !data.minAllowedEquityPercentage ||
      (data.minAllowedEquityPercentage >= MINIMUM_EQUITY_PERCENTAGE &&
        data.minAllowedEquityPercentage <= MAXIMUM_EQUITY_PERCENTAGE),
    {
      message: `Minimum equity percentage must be between ${MINIMUM_EQUITY_PERCENTAGE} and ${MAXIMUM_EQUITY_PERCENTAGE}`,
    },
  )
  .refine(
    (data) =>
      !data.maxAllowedEquityPercentage ||
      (data.maxAllowedEquityPercentage >= MINIMUM_EQUITY_PERCENTAGE &&
        data.maxAllowedEquityPercentage <= MAXIMUM_EQUITY_PERCENTAGE),
    {
      message: `Maximum equity percentage must be between ${MINIMUM_EQUITY_PERCENTAGE} and ${MAXIMUM_EQUITY_PERCENTAGE}`,
    },
  );

export const invoicesRouter = createRouter({
  createAsAdmin: companyProcedure.input(invoiceInputSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.companyAdministrator) throw new TRPCError({ code: "FORBIDDEN" });

    const invoicer = await db.query.users.findFirst({
      where: eq(users.externalId, input.userExternalId),
      with: {
        userComplianceInfos: latestUserComplianceInfo,
        wiseRecipients: {
          where: and(isNull(wiseRecipients.deletedAt), eq(wiseRecipients.usedForInvoices, true)),
          orderBy: desc(wiseRecipients.id),
          limit: 1,
          columns: { lastFourDigits: true },
        },
      },
    });
    if (!invoicer) throw new TRPCError({ code: "NOT_FOUND" });

    const companyWorker = await db.query.companyContractors.findFirst({
      where: and(eq(companyContractors.companyId, ctx.company.id), eq(companyContractors.userId, invoicer.id)),
      with: {
        user: true,
        company: true,
        role: true,
      },
    });
    if (!companyWorker) throw new TRPCError({ code: "NOT_FOUND" });

    const invoiceNumber = await getNextAdminInvoiceNumber(ctx.company.id, invoicer.id);
    const billFrom = assertDefined(invoicer.userComplianceInfos[0]?.businessName || invoicer.legalName);

    let equityAmountInCents = 0n;
    let equityAmountInOptions = 0;
    let equityPercentage = 0;
    const { userExternalId, description, totalAmountCents, ...values } = input;
    const dateToday = new Date();

    if (ctx.company.equityCompensationEnabled) {
      const equityResult = await calculateInvoiceEquity({
        companyContractor: companyWorker,
        serviceAmountCents: totalAmountCents,
        invoiceYear: dateToday.getFullYear(),
        equityCompensationEnabled: true,
        providedEquityPercentage: values.equityPercentage,
      });

      if (!equityResult) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Recipient has insufficient unvested equity",
        });
      }

      if (equityResult.equityPercentage !== values.equityPercentage) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No options would be granted" });
      }

      equityAmountInCents = BigInt(equityResult.equityCents);
      equityAmountInOptions = equityResult.equityOptions;
      equityPercentage = equityResult.equityPercentage;
    }

    const cashAmountInCents = totalAmountCents - equityAmountInCents;

    const { invoice, paymentDescriptions } = await db.transaction(async (tx) => {
      const date = formatISO(dateToday, { representation: "date" });
      const invoiceResult = await tx
        .insert(invoices)
        .values({
          ...values,
          companyId: ctx.company.id,
          userId: invoicer.id,
          createdById: ctx.user.id,
          companyContractorId: companyWorker.id,
          invoiceType: "other",
          invoiceNumber,
          status: "received",
          invoiceDate: date,
          dueOn: date,
          billFrom,
          billTo: assertDefined(ctx.company.name),
          streetAddress: invoicer.streetAddress,
          city: invoicer.city,
          state: invoicer.state,
          zipCode: invoicer.zipCode,
          countryCode: invoicer.countryCode,
          equityPercentage,
          equityAmountInCents,
          equityAmountInOptions,
          totalAmountInUsdCents: totalAmountCents,
          cashAmountInCents,
          flexileFeeCents: getFlexileFeeCents(totalAmountCents),
        })
        .returning();
      const invoice = assertDefined(invoiceResult[0]);

      const lineItems = await tx
        .insert(invoiceLineItems)
        .values({
          invoiceId: invoice.id,
          description,
          totalAmountCents,
        })
        .returning();

      return { invoice, paymentDescriptions: lineItems.map((item) => item.description) };
    });
    const bankAccountLastFour = invoicer.wiseRecipients[0]?.lastFourDigits;

    await sendEmail({
      from: `Flexile <support@${env.DOMAIN}>`,
      to: companyWorker.user.email,
      replyTo: companyWorker.company.email,
      subject: `🔴 Action needed: ${companyWorker.company.name} would like to pay you`,
      react: OneOffInvoiceCreated({
        companyName: companyWorker.company.name || companyWorker.company.email,
        host: ctx.host,
        invoice,
        bankAccountLastFour,
        paymentDescriptions,
      }),
    });

    return invoice;
  }),

  acceptPayment: companyProcedure
    .input(
      z.object({
        id: z.string(),
        equityPercentage: z.number().min(MINIMUM_EQUITY_PERCENTAGE).max(MAXIMUM_EQUITY_PERCENTAGE),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.companyContractor) throw new TRPCError({ code: "FORBIDDEN" });

      const invoice = await db.query.invoices.findFirst({
        where: and(eq(invoices.externalId, input.id), eq(invoices.companyId, ctx.company.id)),
      });
      if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });
      if (invoice.userId !== ctx.companyContractor.userId) throw new TRPCError({ code: "FORBIDDEN" });
      if (invoice.invoiceType !== "other") throw new TRPCError({ code: "FORBIDDEN" });

      if (invoice.minAllowedEquityPercentage !== null && invoice.maxAllowedEquityPercentage !== null) {
        if (
          input.equityPercentage < invoice.minAllowedEquityPercentage ||
          input.equityPercentage > invoice.maxAllowedEquityPercentage
        ) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Equity percentage is out of range" });
        }
      }

      const equityResult = await calculateInvoiceEquity({
        companyContractor: ctx.companyContractor,
        serviceAmountCents: invoice.totalAmountInUsdCents,
        invoiceYear: new Date(invoice.invoiceDate).getFullYear(),
        equityCompensationEnabled: ctx.company.equityCompensationEnabled,
        providedEquityPercentage: input.equityPercentage,
      });

      if (!equityResult) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Error calculating equity. Please contact the administrator.",
        });
      }

      if (equityResult.equityPercentage !== input.equityPercentage) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No options would be granted" });
      }

      const equityAmountInCents = BigInt(equityResult.equityCents);
      const equityAmountInOptions = equityResult.equityOptions;
      const equityPercentage = equityResult.equityPercentage;
      const cashAmountInCents = invoice.totalAmountInUsdCents - equityAmountInCents;

      await db
        .update(invoices)
        .set(
          invoice.minAllowedEquityPercentage !== null && invoice.maxAllowedEquityPercentage !== null
            ? {
                acceptedAt: new Date(),
                equityPercentage,
                cashAmountInCents,
                equityAmountInCents,
                equityAmountInOptions,
              }
            : { acceptedAt: new Date() },
        )
        .where(eq(invoices.id, invoice.id));
    }),

  list: companyProcedure
    .input(
      paginationSchema.and(
        z.object({
          contractorId: z.string().optional(),
          invoiceFilter: z.enum(["history", "actionable"]).optional(),
          after: z.string().optional(),
          before: z.string().optional(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      if (
        !ctx.companyAdministrator &&
        !(ctx.companyContractor && input.contractorId === ctx.companyContractor.externalId)
      )
        throw new TRPCError({ code: "FORBIDDEN" });

      let where = and(
        eq(invoices.companyId, ctx.company.id),
        input.contractorId
          ? eq(invoices.companyContractorId, byExternalId(companyContractors, input.contractorId))
          : undefined,
      );
      if (input.before) where = and(where, lte(invoices.invoiceDate, input.before));
      if (input.after) where = and(where, gte(invoices.invoiceDate, input.after));
      if (input.invoiceFilter) {
        const actionableIds = await actionableByUserInvoiceIds(ctx.user.id, ctx.company);
        where = and(
          where,
          requiresAcceptanceByPayeeFilter ? not(requiresAcceptanceByPayeeFilter) : undefined,
          input.invoiceFilter === "actionable"
            ? inArray(invoices.id, actionableIds)
            : notInArray(invoices.id, actionableIds),
        );
      }
      const rows = await db.query.invoices.findMany({
        with: {
          rejector: { columns: simpleUser.columns },
          approvals: { with: { approver: { columns: simpleUser.columns } } },
          contractor: {
            with: {
              role: { columns: { name: true } },
              user: {
                columns: {},
                with: {
                  userComplianceInfos: { ...latestUserComplianceInfo, columns: { taxInformationConfirmedAt: true } },
                },
              },
            },
          },
        },
        where,
        orderBy: [desc(invoices.invoiceDate), desc(invoices.createdAt)],
        ...pagination(input),
      });
      const count = await db.$count(invoices, where);
      return {
        invoices: rows.map((invoice) => ({
          ...pick(
            invoice,
            "createdAt",
            "invoiceNumber",
            "invoiceDate",
            "totalAmountInUsdCents",
            "totalMinutes",
            "paidAt",
            "rejectedAt",
            "rejectionReason",
            "billFrom",
            "status",
            "cashAmountInCents",
            "equityAmountInCents",
            "equityPercentage",
            "invoiceType",
          ),
          requiresAcceptanceByPayee: requiresAcceptanceByPayee(invoice),
          id: invoice.externalId,
          approvals: invoice.approvals.map((approval) => ({
            approvedAt: approval.approvedAt,
            approver: simpleUser(approval.approver),
          })),
          contractor: {
            ...pick(invoice.contractor, "role"),
            user: { complianceInfo: invoice.contractor.user.userComplianceInfos[0] },
          },
          rejector: invoice.rejector && simpleUser(invoice.rejector),
        })),
        total: count,
      };
    }),

  get: companyProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    if (!ctx.companyAdministrator && !ctx.companyContractor) throw new TRPCError({ code: "FORBIDDEN" });

    const invoice = await db.query.invoices.findFirst({
      where: and(
        eq(invoices.externalId, input.id),
        eq(invoices.companyId, ctx.company.id),
        !ctx.companyAdministrator
          ? eq(invoices.companyContractorId, assertDefined(ctx.companyContractor).id)
          : undefined,
      ),
      with: {
        lineItems: { columns: { description: true, totalAmountCents: true, minutes: true, payRateInSubunits: true } },
        expenses: { columns: { id: true, totalAmountInCents: true, description: true, expenseCategoryId: true } },
        contractor: {
          with: {
            user: {
              columns: { externalId: true },
              with: {
                userComplianceInfos: {
                  ...latestUserComplianceInfo,
                  columns: { taxInformationConfirmedAt: true, businessEntity: true, legalName: true },
                },
              },
            },
          },
        },
        rejector: { columns: simpleUser.columns },
        approvals: { with: { approver: { columns: simpleUser.columns } } },
      },
    });

    if (!invoice) throw new TRPCError({ code: "NOT_FOUND" });

    const attachmentRows = await db.query.activeStorageAttachments.findMany({
      where: and(
        eq(activeStorageAttachments.recordType, "InvoiceExpense"),
        inArray(
          activeStorageAttachments.recordId,
          invoice.expenses.map((expense) => expense.id),
        ),
        eq(activeStorageAttachments.name, "attachment"),
      ),
      with: { blob: { columns: { key: true, filename: true } } },
    });
    const getUrl = (blob: Pick<typeof activeStorageBlobs.$inferSelect, "key" | "filename">) =>
      getS3Url(blob.key, blob.filename);

    const attachments = new Map(
      await Promise.all(
        attachmentRows.map(async (attachment) => [attachment.recordId, await getUrl(attachment.blob)] as const),
      ),
    );

    return {
      ...pick(
        invoice,
        "createdAt",
        "invoiceNumber",
        "invoiceDate",
        "totalAmountInUsdCents",
        "totalMinutes",
        "paidAt",
        "rejectedAt",
        "rejectionReason",
        "billFrom",
        "billTo",
        "cashAmountInCents",
        "equityAmountInCents",
        "notes",
        "status",
        "streetAddress",
        "city",
        "state",
        "zipCode",
        "countryCode",
        "equityPercentage",
        "minAllowedEquityPercentage",
        "maxAllowedEquityPercentage",
      ),
      userId: invoice.contractor.user.externalId,
      requiresAcceptanceByPayee: requiresAcceptanceByPayee(invoice),
      expenses: invoice.expenses.map((expense) => ({
        ...expense,
        attachment: attachments.get(expense.id),
      })),
      lineItems: invoice.lineItems,
      id: invoice.externalId,
      approvals: invoice.approvals.map((approval) => ({
        approvedAt: approval.approvedAt,
        approver: simpleUser(approval.approver),
      })),
      rejector: invoice.rejector && simpleUser(invoice.rejector),
      contractor: {
        ...pick(invoice.contractor, "payRateType"),
        user: { complianceInfo: invoice.contractor.user.userComplianceInfos[0] },
      },
    };
  }),
});
