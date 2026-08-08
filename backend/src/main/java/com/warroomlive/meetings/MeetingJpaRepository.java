package com.warroomlive.meetings;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface MeetingJpaRepository extends JpaRepository<MeetingEntity, Long> {

    Optional<MeetingEntity> findFirstByRoomAndEndedAtIsNullOrderByIdDesc(String room);

    /**
     * One page of a room's meetings, most recent first.
     *
     * <p>Backwards, unlike the calendar: a history is read from the thing that
     * just happened. Native for the same reason as the other list queries —
     * {@code Pageable} expresses paging as page x size and the endpoint takes a
     * free offset.
     */
    @Query(value = "SELECT * FROM meetings WHERE room = :room "
            + "ORDER BY started_at DESC, id DESC LIMIT :limit OFFSET :offset",
            nativeQuery = true)
    List<MeetingEntity> pageForRoom(@Param("room") String room,
            @Param("limit") int limit, @Param("offset") int offset);

    /** Retention candidates, oldest first and bounded. */
    List<MeetingEntity> findByStartedAtBeforeOrderByStartedAtAsc(Instant cutoff, Limit limit);
}
