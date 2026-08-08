package com.warroomlive.transcript;

import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * A room's transcript. Postgres profile only — without a database the captions
 * still work live, they are simply not kept, and the config endpoint says so
 * rather than letting a room believe it is being recorded.
 */
@Component
@Profile("postgres")
public class TranscriptStore {

    private final TranscriptJpaRepository repository;

    public TranscriptStore(TranscriptJpaRepository repository) {
        this.repository = repository;
    }

    @Transactional
    public TranscriptLineEntity append(String room, String peerId, String speaker, String lang,
            String text, Instant spokenAt) {
        return repository.save(
                new TranscriptLineEntity(room, peerId, speaker, lang, text, spokenAt));
    }

    /**
     * Attaches a translation that arrived after the line was already shown.
     *
     * <p>Its own transaction, on a different thread from the append: the line is
     * durable and broadcast long before this runs, and a translation that fails
     * to save must not be able to take the utterance with it.
     */
    @Transactional
    public Optional<TranscriptLineEntity> attachTranslation(long id, String translation,
            String translationLang) {
        return repository.findById(id).map(line -> {
            line.translated(translation, translationLang);
            return repository.save(line);
        });
    }

    /** A meeting's window, oldest first — how a transcript is read. */
    @Transactional(readOnly = true)
    public List<TranscriptLineEntity> window(String room, Instant from, Instant to, int limit) {
        return repository.window(room, from, to, Limit.of(limit));
    }

    /**
     * The last {@code limit} lines, oldest first.
     *
     * <p>Queried newest-first and reversed here: a joiner wants the recent tail,
     * and asking the database for the oldest N of a long meeting would replay
     * the wrong end of it.
     */
    @Transactional(readOnly = true)
    public List<TranscriptLineEntity> tail(String room, int limit) {
        List<TranscriptLineEntity> newestFirst =
                repository.findByRoomOrderBySpokenAtDescIdDesc(room, Limit.of(limit));
        List<TranscriptLineEntity> out = new ArrayList<>(newestFirst);
        java.util.Collections.reverse(out);
        return out;
    }

    @Transactional(readOnly = true)
    public List<TranscriptLineEntity> expiredBefore(Instant cutoff, int limit) {
        return repository.findByCreatedAtBeforeOrderByCreatedAtAsc(cutoff, Limit.of(limit));
    }

    @Transactional
    public void deleteAll(List<TranscriptLineEntity> lines) {
        repository.deleteAll(lines);
    }
}
