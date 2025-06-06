import * as React from "react";

// Behaves like `useEffect`, except it's only called when a dependency changes.
export function useOnChange(cb: () => void, deps: readonly unknown[]) {
  const lastValue = React.useRef(deps);
  React.useEffect(() => {
    if (deps.every((item, i) => item === lastValue.current[i])) return;
    cb();
    lastValue.current = deps;
  }, deps);
}
