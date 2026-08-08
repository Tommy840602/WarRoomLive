package com.warroomlive.transcript;

import com.warroomlive.ai.ChatModel;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The meeting, in the four minutes somebody has before the next one.
 *
 * <p>A fixed skeleton — 重點 / 決議 / 待辦 — rather than free prose. Left to
 * itself a model writes a paragraph that reads well and answers nothing; what
 * anybody actually opens a summary for is "what was decided" and "what am I
 * supposed to do", and a heading that is sometimes there and sometimes not
 * cannot be looked for.
 *
 * <p><strong>Written in the language the meeting was held in.</strong> Not the
 * reader's, and not a fixed one: a summary is quoted back to the people who were
 * there, and translating it away from the words they used makes them hunt for
 * their own decision in someone else's phrasing. A bilingual meeting gets the
 * language it mostly used, and the transcript underneath keeps both.
 */
@Component
@Profile("ai")
public class Summarizer {

    /**
     * Enough transcript for a long meeting, bounded so a runaway room cannot
     * post a novel to a model. Trimmed from the front: a meeting's last hour is
     * the one with the decisions in it.
     */
    private static final int MAX_CHARS = 24_000;
    private static final int MAX_TOKENS = 1200;
    private static final DateTimeFormatter CLOCK =
            DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneOffset.UTC);

    private static final String SYSTEM = """
            You summarise a meeting from its transcript.
            Answer in %s, in Markdown, using exactly these three headings and nothing else:

            ## 重點
            ## 決議
            ## 待辦

            Under 重點, 3-6 bullets of what was discussed.
            Under 決議, only decisions that were actually reached; if none were, write \
            one bullet saying so.
            Under 待辦, one bullet per action item as `- [ ] task — @owner`, using the \
            name of the person it was given to, or omitting the @owner when nobody was named. \
            If there are none, write one bullet saying so.

            Use only what is in the transcript. Do not infer decisions that were not made, \
            do not invent owners, and do not add any heading, preamble or closing remark.""";

    private final ChatModel model;

    public Summarizer(ChatModel model) {
        this.model = model;
    }

    public boolean enabled() {
        return model.configured();
    }

    public String model() {
        return model.model();
    }

    /**
     * A summary of these lines, or empty when there is nothing to summarise or
     * the model did not answer.
     *
     * <p>A handful of lines is not a meeting. Summarising two utterances
     * produces something that looks like a record and is not one, and the honest
     * outcome is to have no summary rather than a confident empty one.
     */
    public Optional<String> summarize(List<TranscriptLineEntity> lines) {
        if (lines == null || lines.size() < MIN_LINES) {
            return Optional.empty();
        }
        String language = Lang.describe(dominantTrack(lines));
        // The slow budget: nobody is watching this generate, and cutting a
        // summary off at subtitle speed would produce half a record.
        return model.completeSlow(SYSTEM.formatted(language), transcriptOf(lines), MAX_TOKENS);
    }

    /** Below this a "summary" would be a restatement with extra confidence. */
    public static final int MIN_LINES = 3;

    /**
     * Which language the meeting was mostly held in, by how much was said in it.
     *
     * <p>Weighted by characters rather than by line count: recognition splits
     * speech into utterances at pauses, so a language spoken in short bursts
     * would win a vote it did not deserve.
     */
    static String dominantTrack(List<TranscriptLineEntity> lines) {
        Map<String, Integer> weight = new HashMap<>();
        for (TranscriptLineEntity line : lines) {
            Lang.track(line.getLang()).ifPresent(
                    t -> weight.merge(t, line.getText().length(), Integer::sum));
        }
        return weight.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(Map.Entry::getKey)
                // Nothing recognisable either way: Chinese, because that is this
                // room's own language and a summary has to be in something.
                .orElse(Lang.ZH);
    }

    /** The transcript as the model sees it: who, when, what — nothing else. */
    static String transcriptOf(List<TranscriptLineEntity> lines) {
        StringBuilder out = new StringBuilder();
        for (TranscriptLineEntity line : lines) {
            out.append('[').append(CLOCK.format(line.getSpokenAt())).append("] ")
                    .append(line.getSpeaker()).append(": ")
                    .append(line.getText().strip()).append('\n');
        }
        // From the end, when it is too long: a meeting's decisions live at its
        // close, and dropping the tail to keep the small talk would be backwards.
        if (out.length() > MAX_CHARS) {
            return "…\n" + out.substring(out.length() - MAX_CHARS);
        }
        return out.toString();
    }
}
