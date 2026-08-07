package com.warroomlive.agenda;

/**
 * Where an item sits on the dashboard: am I dealing with this now, or later?
 *
 * <p>Chandler's triage, and its point is that this is not a priority and not a
 * deadline. "Important" and "due Friday" are properties of the work; NOW and
 * LATER are a decision about attention, and a room makes that decision together.
 *
 * <p>Only these two are stored. An item auto-triages from its due time until
 * somebody disagrees, and what gets written down is the disagreement — so a
 * stored value always means "a person said so". DONE is absent on purpose: it
 * is not an opinion about attention but a fact about the work, and it already
 * has a home in the completion columns, which also record who and when. A
 * caller may still <em>ask</em> for DONE; the controller turns that into a
 * completion rather than storing the word twice.
 */
public enum Triage {
    NOW,
    LATER;

    /**
     * Parses a client's value, or null for "let the clock decide again".
     *
     * @throws IllegalArgumentException on anything else — an unrecognised
     *         triage is a caller bug, and silently filing the item under the
     *         clock's opinion would look like it worked.
     */
    public static Triage parse(String value) {
        if (value == null || value.isBlank() || value.equalsIgnoreCase("auto")) {
            return null;
        }
        return Triage.valueOf(value.trim().toUpperCase());
    }
}
