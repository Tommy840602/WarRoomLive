package com.warroomlive.transcript;

import java.util.Optional;

/**
 * Turns one spoken line into the other subtitle language.
 *
 * <p>Two implementations, selected by profile: {@link DisabledTranslator} by
 * default, so the feature costs nothing and depends on nothing, and
 * {@link ModelTranslator} under the {@code ai} profile. The same shape as
 * {@code ChatRepository} and {@code Backplane} — the zero-dependency default is
 * a real implementation with honest behaviour, not a stub that throws.
 */
public interface Translator {

    /**
     * The translation of {@code text}, or empty when there is none to give.
     *
     * <p>Empty covers every way this can decline: translation is switched off,
     * the source language is neither Chinese nor English, the model refused, the
     * call timed out. The caller treats them alike — an untranslated line is a
     * normal outcome, not an error, and the original subtitle has already been
     * shown either way.
     *
     * @param text       one final utterance
     * @param sourceLang BCP-47 tag the recognizer reported
     */
    Optional<Translation> translate(String text, String sourceLang);

    /** Whether anything will ever come back, so the UI can say so up front. */
    boolean enabled();

    /** @param lang the {@code zh}/{@code en} track this text is in. */
    record Translation(String text, String lang) {
    }
}
