import { renderHook, cleanup } from "@testing-library/react";
import { useDeepMemo } from "../common/utils.js";
import { expect, describe, it, afterEach } from "vitest";

describe("useDeepMemo", () => {
    afterEach(cleanup);

    it("returns the initial value", () => {
        const initialValue = { a: 1 };
        const { result } = renderHook(() => useDeepMemo(initialValue));
        expect(result.current).toEqual(initialValue);
    });

    it("updates the value on deep change", () => {
        const initialValue = { a: 1 };
        const changedValue = { a: 2 };
        const { result, rerender } = renderHook(({ value }) => useDeepMemo(value), {
            initialProps: { value: initialValue },
        });

        expect(result.current).toEqual(initialValue);

        // Change the value deeply
        rerender({ value: changedValue });
        expect(result.current).toEqual(changedValue);
    });

    it("does not update the value on shallow/no change", () => {
        const initialValue = { a: 1 };
        const sameValue = { a: 1 };
        const { result, rerender } = renderHook(({ value }) => useDeepMemo(value), {
            initialProps: { value: initialValue },
        });

        expect(result.current).toEqual(initialValue);

        // Re-render with the same value (shallow change)
        rerender({ value: sameValue });
        expect(result.current).toEqual(initialValue);
    });

    it("compares a new but equal input once, not on every render after", () => {
        // A getter counts how often the value is read, which is how often a
        // deep comparison walked it.
        let reads = 0;
        const counted = (): { readonly a: number } => ({
            get a() {
                reads += 1;
                return 1;
            },
        });
        const first = counted();
        const equal = counted();
        const { result, rerender } = renderHook(({ value }) => useDeepMemo(value), {
            initialProps: { value: first },
        });

        rerender({ value: equal });
        expect(result.current).toBe(first);
        const reads_after_first_comparison = reads;
        expect(reads_after_first_comparison).toBeGreaterThan(0);

        rerender({ value: equal });
        rerender({ value: equal });
        expect(result.current).toBe(first);
        expect(reads).toBe(reads_after_first_comparison);
    });

    it("still adopts a changed value after an equal one", () => {
        const { result, rerender } = renderHook(({ value }) => useDeepMemo(value), {
            initialProps: { value: { a: 1 } },
        });
        rerender({ value: { a: 1 } });
        const changed = { a: 2 };
        rerender({ value: changed });
        expect(result.current).toBe(changed);
    });
});
