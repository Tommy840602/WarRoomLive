package com.warroomlive.transcript;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.warroomlive.signaling.SignalMessage;
import com.warroomlive.signaling.SignalingHandler;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Keeps what was said, and chases the translation without making anyone wait.
 *
 * <p>The order here is the whole design:
 *
 * <ol>
 *   <li>the line is written and its id returned, so the caller can broadcast the
 *       original <em>now</em>;</li>
 *   <li>translation is queued on a small pool and lands later as a separate
 *       message keyed by that id.</li>
 * </ol>
 *
 * <p>Doing it the other way — translate, then broadcast both together — would
 * put a language model on the critical path of a live subtitle, which is a
 * contradiction in terms. A caption that appears a beat after the words is a
 * caption; one that appears three seconds later is a transcript scrolling past
 * at the wrong moment.
 *
 * <p><strong>Under load, translations are dropped rather than queued.</strong>
 * The queue is small and overflow is discarded on purpose: a translation that
 * comes out two minutes late is not a late subtitle, it is a wrong one, because
 * by then it is captioning a different part of the conversation. The line itself
 * is already durable and already on screen — what is lost is only the second
 * language, and the counter says how often.
 */
@Component
@Profile("postgres")
public class TranscriptRecorder {

    private static final Logger log = LoggerFactory.getLogger(TranscriptRecorder.class);

    /** Sized for a busy room's backlog, not for a queue that hides a slow model. */
    private static final int QUEUE_DEPTH = 64;
    private static final int THREADS = 4;

    private final TranscriptStore store;
    private final Translator translator;
    private final ObjectProvider<SignalingHandler> signaling;
    private final ObjectMapper mapper;
    private final ThreadPoolExecutor pool;
    private final Counter dropped;

    public TranscriptRecorder(TranscriptStore store, Translator translator,
            ObjectProvider<SignalingHandler> signaling, ObjectMapper mapper,
            MeterRegistry metrics) {
        this.store = store;
        this.translator = translator;
        this.signaling = signaling;
        this.mapper = mapper;

        AtomicInteger n = new AtomicInteger();
        this.dropped = metrics.counter("warroomlive.caption.translate.dropped");
        this.pool = new ThreadPoolExecutor(THREADS, THREADS, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(QUEUE_DEPTH),
                r -> {
                    Thread t = new Thread(r, "caption-translate-" + n.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                },
                // Discard, and say so. Silently dropping would make a saturated
                // translator look exactly like a room where nobody spoke a second
                // language, which are very different things to be paged about.
                (task, executor) -> dropped.increment());
        metrics.gauge("warroomlive.caption.translate.queue", pool, p -> p.getQueue().size());
    }

    public boolean translationEnabled() {
        return translator.enabled();
    }

    /**
     * Records one final utterance and queues its translation.
     *
     * @return the line's id, for the caller to put on the broadcast so the
     *         translation that follows can be matched to it
     */
    public Optional<Long> record(String room, String peerId, String speaker, String lang,
            String text, Instant spokenAt) {
        TranscriptLineEntity line;
        try {
            line = store.append(room, peerId, speaker, lang, text, spokenAt);
        } catch (RuntimeException e) {
            // A transcript that cannot be written must not take the caption with
            // it: people are watching subtitles, and losing those too because the
            // database is unhappy makes a storage problem into a meeting problem.
            log.warn("Could not record transcript line for room {}", room, e);
            return Optional.empty();
        }
        long id = line.getId();
        if (translator.enabled() && Lang.counterpart(lang).isPresent()) {
            pool.execute(() -> translate(room, id, text, lang));
        }
        return Optional.of(id);
    }

    private void translate(String room, long id, String text, String lang) {
        try {
            Optional<Translator.Translation> result = translator.translate(text, lang);
            if (result.isEmpty()) return;
            Translator.Translation translation = result.get();
            store.attachTranslation(id, translation.text(), translation.lang());

            Map<String, Object> payload = new HashMap<>();
            payload.put("id", id);
            payload.put("translation", translation.text());
            payload.put("translationLang", translation.lang());
            SignalingHandler handler = signaling.getIfAvailable();
            if (handler != null) {
                handler.broadcastToRoom(room, new SignalMessage(
                        SignalMessage.TYPE_CAPTION_TRANSLATED, room, null, null,
                        mapper.valueToTree(payload)));
            }
        } catch (Exception e) {
            log.debug("Translation of line {} failed: {}", id, e.toString());
        }
    }
}
