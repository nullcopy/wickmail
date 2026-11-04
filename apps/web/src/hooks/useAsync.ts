import { useCallback, useEffect, useState, type DependencyList } from "react";

/** The result of an async load. */
export interface AsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/**
 * Run an async loader when its dependencies change, tracking loading and error
 * state. A `reload` re-runs the loader; stale results are discarded.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader().then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, loading, error, reload };
}
