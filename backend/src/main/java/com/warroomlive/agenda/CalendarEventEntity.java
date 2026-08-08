package com.warroomlive.agenda;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
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
 *
 * <p>It carries completion and triage for the same reason a to-do does: on the
 * dashboard these are one kind of item, and an entry nobody can mark as dealt
 * with is an entry that sits in the way forever.
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

    /** Free text: the person an appointment belongs to is often not a user here. */
    @Column
    private String assignee;

    @Column(name = "created_by", nullable = false)
    private String createdBy;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "completed_by")
    private String completedBy;

    /** When the room was told this had come due. Null until it has been. */
    @Column(name = "reminded_at")
    private Instant remindedAt;

    /** Null means the clock decides; a value means somebody disagreed with it. */
    @Enumerated(EnumType.STRING)
    @Column(name = "triage", length = 8)
    private Triage triage;

    protected CalendarEventEntity() {
    }

    public CalendarEventEntity(String room, String title, String description,
            Instant startsAt, Instant endsAt, String assignee, String createdBy) {
        this.room = room;
        this.title = title;
        this.description = description == null ? "" : description;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.assignee = assignee;
        this.createdBy = createdBy;
        this.createdAt = Instant.now();
    }

    public void edit(String title, String description, Instant startsAt, Instant endsAt,
            String assignee) {
        this.title = title;
        this.description = description == null ? "" : description;
        this.startsAt = startsAt;
        this.endsAt = endsAt;
        this.assignee = assignee;
    }

    public String getAssignee() {
        return assignee;
    }

    /**
     * Marks the entry dealt with, or not.
     *
     * <p>Same rule as a to-do: re-completing keeps the original time and author,
     * so a second click cannot rewrite who closed it.
     */
    public void setDone(boolean done, String actor) {
        if (!done) {
            this.completedAt = null;
            this.completedBy = null;
        } else if (this.completedAt == null) {
            this.completedAt = Instant.now();
            this.completedBy = actor;
        }
    }

    public boolean isDone() {
        return completedAt != null;
    }

    /** Null hands the entry back to the clock. */
    public void setTriage(Triage triage) {
        this.triage = triage;
    }

    public Triage getTriage() {
        return triage;
    }

    public Instant getRemindedAt() {
        return remindedAt;
    }

    public void markReminded() {
        this.remindedAt = Instant.now();
    }

    public Instant getCompletedAt() {
        return completedAt;
    }

    public String getCompletedBy() {
        return completedBy;
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
