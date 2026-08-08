package com.warroomlive.agenda;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;

public interface CalendarEventJpaRepository extends JpaRepository<CalendarEventEntity, Long> {

    /**
     * One page of a room's calendar from a point in time, soonest first.
     *
     * <p>A calendar is read forwards: the default {@code from} is now, so the
     * list opens on what is coming rather than on whatever happened first in
     * the room's history. Passing an earlier instant is how the past is read.
     */
    @Query(value = "SELECT * FROM calendar_events WHERE room = :room AND starts_at >= :from "
            + "ORDER BY starts_at ASC, id ASC LIMIT :limit OFFSET :offset",
            nativeQuery = true)
    List<CalendarEventEntity> pageForRoom(@Param("room") String room, @Param("from") Instant from,
            @Param("limit") int limit, @Param("offset") int offset);

    /** Entries that have started and whose room has not been told. Same rules as to-dos. */
    @Query(value = "SELECT * FROM calendar_events WHERE starts_at <= :now "
            + "AND reminded_at IS NULL AND completed_at IS NULL ORDER BY starts_at ASC LIMIT :limit",
            nativeQuery = true)
    List<CalendarEventEntity> dueAndUnannounced(@Param("now") Instant now, @Param("limit") int limit);

    /** Retention candidates, oldest first and bounded. */
    List<CalendarEventEntity> findByCreatedAtBeforeOrderByCreatedAtAsc(Instant cutoff, Limit limit);
}
