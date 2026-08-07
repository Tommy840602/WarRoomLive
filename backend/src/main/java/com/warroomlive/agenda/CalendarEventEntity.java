package com.warroomlive.agenda;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * An entry on a room's shared calendar.
 *
 * <p>Times are instants, not local dates. A cross-department room is the case
 * where two people read the same entry from different time zones, and a naive
 * timestamp is exactly the thing that makes them show up an hour apart.
 */
@Entity
@Table(name = "calendar_events")
public class CalendarEventEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, length = 2000)
    private String description;

    @Column(name = "starts_at", nullable = false)
    private Instant startsAt;

    /** Null for an entry that is a moment rather than a span. */
    @Column(name = "ends_at")
    private Instant endsAt;

    @Column(name = "created_by", nullable = false)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected CalendarEventEntity() {
    }

    public CalendarEventEntity(String room, String title, String description,
            Instant startsAt, Instant endsAt, String createdBy) {
        this.room = room;
        this.title = title;
        this.description = description == null ? "" : description;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.createdBy = createdBy;
        this.createdAt = Instant.now();
    }

    public void edit(String title, String description, Instant startsAt, Instant endsAt) {
        this.title = title;
        this.description = description == null ? "" : description;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
    }

    public Long getId() {
        return id;
    }

    public String getRoom() {
        return room;
    }

    public String getTitle() {
        return title;
    }

    public String getDescription() {
        return description;
    }

    public Instant getStartsAt() {
        return startsAt;
    }

    public Instant getEndsAt() {
        return endsAt;
    }

    public String getCreatedBy() {
        return createdBy;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
