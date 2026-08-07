package com.warroomlive.web;

/**
 * Clamping for the {@code limit}/{@code offset} pair the list endpoints take.
 *
 * <p>Out-of-range paging is clamped rather than rejected. A caller asking for a
 * thousand rows wants as many as it can get, and a page of two hundred is a
 * better answer than an error; a negative offset is a bug in the caller, not an
 * instruction worth honouring. What is not negotiable is the ceiling — it is the
 * only thing standing between one request and a response the size of the table.
 */
final class Pages {

    private Pages() {
    }

    static int limit(int requested, int fallback, int max) {
        if (requested <= 0) {
            return fallback;
        }
        return Math.min(requested, max);
    }

    static int offset(int requested) {
        return Math.max(requested, 0);
    }
}
