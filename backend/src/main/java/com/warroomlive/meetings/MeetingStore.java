package com.warroomlive.meetings;

import org.springframework.context.annotation.Profile;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

/**
 * Reading a room's meetings back.
 *
 * <p>{@link MeetingTracker} has been writing these rows since the meeting
 * domain landed — when a room opened, when it emptied, how long it ran, how
 * many people were in it at the busiest moment — and nothing has ever read one.
 * A write-only table is a table whose contents nobody can check, which is the
 * same as not having recorded them.
 */
@Component
@Profile("postgres")
public class MeetingStore {

    private final MeetingJpaRepository repository;

    public MeetingStore(MeetingJpaRepository repository) {
        this.repository = repository;
    }

    @Transactional(readOnly = true)
    public List<MeetingEntity> forRoom(String room, int limit, int offset) {
        return repository.pageForRoom(room, limit, offset);
    }

    @Transactional(readOnly = true)
    public Optional<MeetingEntity> byId(String room, long id) {
        return repository.findById(id).filter(m -> m.room().equals(room));
    }

    /**
     * Retention candidates by <em>start</em>, not by end.
     *
     * <p>A meeting that never closed — the node died while someone was still in
     * the room — has no end at all, and ageing on a null column would keep those
     * rows for ever. The start is always there.
     */
    @Transactional(readOnly = true)
    public List<MeetingEntity> expiredBefore(java.time.Instant cutoff, int limit) {
        return repository.findByStartedAtBeforeOrderByStartedAtAsc(cutoff, Limit.of(limit));
    }

    @Transactional
    public void deleteAll(List<MeetingEntity> meetings) {
        repository.deleteAll(meetings);
    }
}
