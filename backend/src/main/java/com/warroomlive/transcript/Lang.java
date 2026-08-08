package com.warroomlive.transcript;

import java.util.Locale;
import java.util.Optional;

/**
 * The two languages this room translates between, and how to recognise them in
 * whatever tag a browser hands over.
 *
 * <p>Speech recognition reports BCP-47, and it is not tidy: Chrome says
 * {@code cmn-Hant-TW} for Taiwanese Mandarin, {@code zh-TW} in older builds,
 * {@code yue-Hant-HK} for Cantonese, {@code en-US} and {@code en-GB} for
 * English. All the Chinese varieties are one subtitle track here and all the
 * English ones are the other, so the tag is reduced to {@code zh} or {@code en}
 * and everything else is declined rather than guessed at.
 *
 * <p>Declining is deliberate. Somebody speaking Japanese into a room configured
 * for Chinese and English should see no translation at all, rather than a
 * confident mistranslation into a language they did not ask for.
 */
public final class Lang {

    public static final String ZH = "zh";
    public static final String EN = "en";

    private Lang() {
    }

    /**
     * The subtitle track a BCP-47 tag belongs to, or empty when it is neither.
     *
     * <p>Matched on the primary subtag, except that Mandarin and Cantonese carry
     * ISO-639-3 primary subtags ({@code cmn}, {@code yue}) that do not begin
     * with {@code zh} at all — the case a naive {@code startsWith("zh")} gets
     * wrong on the exact locale a Taiwanese room uses.
     */
    public static Optional<String> track(String tag) {
        if (tag == null || tag.isBlank()) return Optional.empty();
        String primary = tag.trim().toLowerCase(Locale.ROOT).split("[-_]")[0];
        return switch (primary) {
            // zh: the macrolanguage. cmn/yue/nan/hak/wuu: the varieties Chrome
            // actually reports for Mandarin, Cantonese, Hokkien, Hakka and Wu.
            case "zh", "cmn", "yue", "nan", "hak", "wuu" -> Optional.of(ZH);
            case "en" -> Optional.of(EN);
            default -> Optional.empty();
        };
    }

    /** The other track — what a line gets translated into. Empty when the tag is neither. */
    public static Optional<String> counterpart(String tag) {
        return track(tag).map(t -> ZH.equals(t) ? EN : ZH);
    }

    /** How the model is asked for the target, in words rather than a code. */
    public static String describe(String track) {
        return ZH.equals(track) ? "Traditional Chinese (繁體中文)" : "English";
    }
}
