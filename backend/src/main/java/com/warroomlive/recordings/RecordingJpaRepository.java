package com.warroomlive.recordings;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface RecordingJpaRepository extends JpaRepository<RecordingEntity, Long> {

    /**
     * One page of a room's recordings, newest first. Written as a native query
     * because {@code Pageable} expresses paging as page number × size, and the
     * endpoint takes a free-standing offset.
     */
    @Query(value = "SELECT * FROM recordings WHERE room = :room "
            + "ORDER BY ended_at DESC, id DESC LIMIT :limit OFFSET :offset",
            nativeQuery = true)
    List<RecordingEntity> pageForRoom(@Param("room") String room,
            @Param("limit") int limit, @Param("offset") int offset);

    Optional<RecordingEntity> findByEgressId(String egressId);

    /** Retention candidates, oldest first and bounded — one sweep must not load the table. */
    List<RecordingEntity> findByEndedAtBeforeOrderByEndedAtAsc(Instant cutoff, Limit limit);
}
