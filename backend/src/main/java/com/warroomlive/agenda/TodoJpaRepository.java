package com.warroomlive.agenda;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;

public interface TodoJpaRepository extends JpaRepository<TodoEntity, Long> {

    /**
     * One page of a room's items: open ones first, then soonest-due, then
     * oldest. What is still open is the question the list exists to answer, so
     * completed items must never push it below the fold.
     *
     * <p>Native for the same reason as the other list queries — {@code Pageable}
     * expresses paging as page × size and the endpoint takes a free offset.
     * {@code NULLS LAST} on the due date keeps undated items after dated ones
     * rather than sorting them to the top, which is Postgres's default for DESC
     * and the opposite of useful here.
     */
    @Query(value = "SELECT * FROM todos WHERE room = :room "
            + "ORDER BY (completed_at IS NOT NULL), due_at ASC NULLS LAST, id ASC "
            + "LIMIT :limit OFFSET :offset",
            nativeQuery = true)
    List<TodoEntity> pageForRoom(@Param("room") String room,
            @Param("limit") int limit, @Param("offset") int offset);

    /** Retention candidates, oldest first and bounded. */
    List<TodoEntity> findByCreatedAtBeforeOrderByCreatedAtAsc(Instant cutoff, Limit limit);
}
