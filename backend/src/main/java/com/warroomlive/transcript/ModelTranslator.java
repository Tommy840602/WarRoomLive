package com.warroomlive.transcript;

import com.warroomlive.ai.ChatModel;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Translation by language model, under the {@code ai} profile.
 *
 * <p>The prompt is short and the instruction narrow on purpose. This is not a
 * chat: the model is being asked to do one mechanical thing to one sentence, and
 * every extra sentence of instruction is another opportunity for it to decide to
 * be helpful — to answer a question in the transcript, to explain an acronym, to
 * apologise for an unclear recording. A subtitle track that occasionally editorialises
 * is worse than one that occasionally omits.
 */
@Component
@Profile("ai")
public class ModelTranslator implements Translator {

    /**
     * Enough for the longest single utterance a recognizer emits, and no more.
     * The output is one sentence; a ceiling that allows a paragraph only buys
     * time for a model that has stopped translating and started talking.
     */
    private static final int MAX_TOKENS = 400;

    private static final String SYSTEM = """
            You translate one line of meeting speech at a time.
            Reply with the translation only: no quotes, no notes, no explanation, \
            no romanisation, and never an answer to anything the line asks.
            Keep names, product names, numbers and acronyms as they are.
            If the line is already in the target language, or is too garbled to \
            translate, reply with exactly: -""";

    private final ChatModel model;
    private final Timer latency;

    public ModelTranslator(ChatModel model, MeterRegistry metrics) {
        this.model = model;
        this.latency = Timer.builder("warroomlive.caption.translate")
                .description("Time to translate one final caption line")
                .publishPercentileHistogram()
                .register(metrics);
    }

    @Override
    public Optional<Translation> translate(String text, String sourceLang) {
        Optional<String> target = Lang.counterpart(sourceLang);
        if (target.isEmpty() || text == null || text.isBlank()) {
            return Optional.empty();
        }
        String to = target.get();
        Optional<String> reply = latency.record(() -> model.complete(
                SYSTEM, "Translate into " + Lang.describe(to) + ":\n" + text.strip(), MAX_TOKENS));
        return reply
                // The model's own way of saying it had nothing to add. Treated
                // as no translation rather than shown, so a subtitle never reads "-".
                .filter(t -> !t.isBlank() && !t.strip().equals("-"))
                .map(t -> new Translation(t, to));
    }

    @Override
    public boolean enabled() {
        return model.configured();
    }
}
