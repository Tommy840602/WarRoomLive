package com.warroomlive.events;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface OutboxJpaRepository extends JpaRepository<OutboxEventEntity, Long> {

    /**
     * Claims the next batch of unpublished events. {@code FOR UPDATE SKIP LOCKED}
     * lets multiple backend replicas poll concurrently without double-publishing
     * (each row is claimed by exactly one transaction at a time).
     */
    @Query(value = """
            SELECT * FROM outbox_events
            WHERE published_at IS NULL
            ORDER BY id
            LIMIT :batch
            FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<OutboxEventEntity> lockNextUnpublished(@Param("batch") int batch);

    long countByPublishedAtIsNull();
}
