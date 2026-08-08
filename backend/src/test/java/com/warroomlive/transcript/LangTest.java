package com.warroomlive.transcript;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class LangTest {

    @Test
    void recognisesTheTagsChromeActuallyReports() {
        // The important one: Chrome says cmn-Hant-TW for Taiwanese Mandarin,
        // which a naive startsWith("zh") gets wrong on exactly the locale this
        // room uses most.
        assertThat(Lang.track("cmn-Hant-TW")).contains(Lang.ZH);
        assertThat(Lang.track("zh-TW")).contains(Lang.ZH);
        assertThat(Lang.track("yue-Hant-HK")).contains(Lang.ZH);
        assertThat(Lang.track("en-US")).contains(Lang.EN);
        assertThat(Lang.track("en-GB")).contains(Lang.EN);
    }

    @Test
    void isCaseAndSeparatorInsensitive() {
        assertThat(Lang.track("EN_us")).contains(Lang.EN);
        assertThat(Lang.track("  cmn-hant-tw ")).contains(Lang.ZH);
    }

    @Test
    void declinesAnythingItIsNotSureAbout() {
        // Somebody speaking Japanese into a zh/en room should get no translation
        // rather than a confident mistranslation into a language nobody asked for.
        assertThat(Lang.track("ja-JP")).isEmpty();
        assertThat(Lang.track("")).isEmpty();
        assertThat(Lang.track(null)).isEmpty();
        assertThat(Lang.counterpart("ja-JP")).isEmpty();
    }

    @Test
    void translatesIntoTheOtherTrack() {
        assertThat(Lang.counterpart("cmn-Hant-TW")).contains(Lang.EN);
        assertThat(Lang.counterpart("en-US")).contains(Lang.ZH);
    }
}
