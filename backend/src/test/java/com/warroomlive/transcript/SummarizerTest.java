package com.warroomlive.transcript;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SummarizerTest {

    private static TranscriptLineEntity line(String speaker, String lang, String text) {
        return new TranscriptLineEntity("room", "p", speaker, lang, text,
                Instant.parse("2026-08-08T09:00:00Z"));
    }

    @Test
    void picksTheLanguageMostOfTheMeetingWasHeldIn() {
        List<TranscriptLineEntity> lines = List.of(
                line("A", "cmn-Hant-TW", "我們今天要決定上線時程還有誰負責處理登入"),
                line("B", "en-US", "ok"));
        assertThat(Summarizer.dominantTrack(lines)).isEqualTo(Lang.ZH);
    }

    @Test
    void weighsByHowMuchWasSaidRatherThanByLineCount() {
        // Recognition splits speech at pauses, so a language spoken in short
        // bursts would win a vote it did not deserve.
        List<TranscriptLineEntity> lines = List.of(
                line("A", "cmn-Hant-TW", "對"),
                line("A", "cmn-Hant-TW", "好"),
                line("A", "cmn-Hant-TW", "嗯"),
                line("B", "en-US",
                        "So the plan is to ship the login fix next week and review it on Friday"));
        assertThat(Summarizer.dominantTrack(lines)).isEqualTo(Lang.EN);
    }

    @Test
    void fallsBackToChineseWhenNothingIsRecognisable() {
        // A summary has to be written in something, and this room's own
        // language is the honest default.
        assertThat(Summarizer.dominantTrack(List.of(line("A", "ja-JP", "こんにちは"))))
                .isEqualTo(Lang.ZH);
        assertThat(Summarizer.dominantTrack(List.of())).isEqualTo(Lang.ZH);
    }

    @Test
    void rendersTheTranscriptAsWhoWhenWhat() {
        String rendered = Summarizer.transcriptOf(List.of(line("Alice", "en-US", "hello")));
        assertThat(rendered).isEqualTo("[09:00] Alice: hello\n");
    }

    @Test
    void keepsTheEndOfAnOverlongTranscriptRatherThanTheStart() {
        // A meeting's decisions live at its close; dropping the tail to keep the
        // small talk would be exactly backwards.
        List<TranscriptLineEntity> many = java.util.stream.IntStream.range(0, 4000)
                .mapToObj(i -> line("A", "en-US", "sentence number " + i))
                .toList();
        String rendered = Summarizer.transcriptOf(many);
        assertThat(rendered).startsWith("…\n");
        assertThat(rendered).contains("sentence number 3999");
        assertThat(rendered).doesNotContain("sentence number 0\n");
    }
}
