package com.warroomlive.transcript;

import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * The default: captions in the language they were spoken, and nothing else.
 *
 * <p>Translation needs a language model, which is an external service with a
 * bill attached, so it is opt-in ({@code ai} profile). What matters is that the
 * rest of the feature — live captions, the transcript, the record — works with
 * no such thing configured, and that the UI is told translation is off rather
 * than left waiting for a translation that is never coming.
 */
@Component
@Profile("!ai")
public class DisabledTranslator implements Translator {

    @Override
    public Optional<Translation> translate(String text, String sourceLang) {
        return Optional.empty();
    }

    @Override
    public boolean enabled() {
        return false;
    }
}
