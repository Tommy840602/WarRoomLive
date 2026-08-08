package com.warroomlive.transcript;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;

public interface TranscriptJpaRepository extends JpaRepository<TranscriptLineEntity, Long> {

    /**
     * A window of a room's transcript, in the order it was spoken.
     *
     * <p>Spoken order, not insertion order: two people talking at once produce
     * rows whose ids interleave by whichever recognizer finished first, and a
     * transcript that reads in that order reads as nonsense.
     */
    @Query("""
            SELECT t FROM TranscriptLineEntity t
            WHERE t.room = :room AND t.spokenAt >= :from AND t.spokenAt <= :to
            ORDER BY t.spokenAt ASC, t.id ASC
            """)
    List<TranscriptLineEntity> window(@Param("room") String room, @Param("from") Instant from,
            @Param("to") Instant to, Limit limit);

    /** The tail of a room's transcript, newest first — reversed by the caller for replay. */
    List<TranscriptLineEntity> findByRoomOrderBySpokenAtDescIdDesc(String room, Limit limit);

    List<TranscriptLineEntity> findByCreatedAtBeforeOrderByCreatedAtAsc(Instant cutoff, Limit limit);
}
