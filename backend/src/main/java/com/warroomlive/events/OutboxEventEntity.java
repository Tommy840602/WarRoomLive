package com.warroomlive.events;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

/** One row per business event awaiting (or having completed) broker publication. */
@Entity
@Table(name = "outbox_events")
public class OutboxEventEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "event_id", nullable = false, unique = true)
    private UUID eventId;

    @Column(name = "event_type", nullable = false, length = 100)
    private String eventType;

    @Column(name = "aggregate_type", nullable = false, length = 50)
    private String aggregateType;

    @Column(name = "aggregate_id", nullable = false)
    private String aggregateId;

    @Column(name = "schema_version", nullable = false)
    private int schemaVersion;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "occurred_at", nullable = false)
    private Instant occurredAt;

    @Column(name = "published_at")
    private Instant publishedAt;

    protected OutboxEventEntity() {
    }

    OutboxEventEntity(String eventType, String aggregateType, String aggregateId, String payloadJson) {
        this.eventId = UUID.randomUUID();
        this.eventType = eventType;
        this.aggregateType = aggregateType;
        this.aggregateId = aggregateId;
        this.schemaVersion = 1;
        this.payload = payloadJson;
        this.occurredAt = Instant.now();
    }

    Long id() {
        return id;
    }

    UUID eventId() {
        return eventId;
    }

    String eventType() {
        return eventType;
    }

    String aggregateType() {
        return aggregateType;
    }

    String aggregateId() {
        return aggregateId;
    }

    int schemaVersion() {
        return schemaVersion;
    }

    String payload() {
        return payload;
    }

    Instant occurredAt() {
        return occurredAt;
    }

    void markPublished() {
        this.publishedAt = Instant.now();
    }
}
