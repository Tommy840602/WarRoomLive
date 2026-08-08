package com.warroomlive.transcript;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * What one meeting was about, drawn from its transcript.
 *
 * <p>Stored rather than recomputed on demand. It costs a model call, it is read
 * far more often than it is made, and — the part that decides it — asking again
 * later would produce a <em>different</em> summary of the same meeting. Somebody
 * quoting this in a ticket needs it to still say that next month.
 */
@Entity
@Table(name = "meeting_summaries")
public class MeetingSummaryEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "meeting_id", nullable = false, unique = true)
    private Long meetingId;

    @Column(nullable = false)
    private String room;

    /** Kept with the text: a summary is an opinion, and its author is part of it. */
    @Column(nullable = false)
    private String model;

    @Column(name = "summary_md", nullable = false, columnDefinition = "text")
    private String summaryMd;

    /**
     * How many transcript lines went in. A summary of three lines and one of
     * three hundred deserve different amounts of trust, and nothing in the prose
     * itself tells them apart.
     */
    @Column(name = "line_count", nullable = false)
    private int lineCount;

    @Column(name = "generated_at", nullable = false)
    private Instant generatedAt;

    /**
     * Microseconds, because that is all a {@code timestamptz} column keeps.
     *
     * <p>Without this the value handed back at creation carries nanoseconds the
     * database is about to drop, so the same field reads back differently the
     * moment it is fetched rather than created — and a client that treats
     * {@code generatedAt} as "has this changed?" sees a change that never
     * happened.
     */
    private static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    protected MeetingSummaryEntity() {
    }

    public MeetingSummaryEntity(long meetingId, String room, String model, String summaryMd,
            int lineCount) {
        this.meetingId = meetingId;
        this.room = room;
        this.model = model;
        this.summaryMd = summaryMd;
        this.lineCount = lineCount;
        this.generatedAt = now();
    }

    /** Replaces the text on an explicit regenerate, and re-dates it. */
    public void replace(String summaryMd, String model, int lineCount) {
        this.summaryMd = summaryMd;
        this.model = model;
        this.lineCount = lineCount;
        this.generatedAt = now();
    }

    public Long getId() {
        return id;
    }

    public Long getMeetingId() {
        return meetingId;
    }

    public String getRoom() {
        return room;
    }

    public String getModel() {
        return model;
    }

    public String getSummaryMd() {
        return summaryMd;
    }

    public int getLineCount() {
        return lineCount;
    }

    public Instant getGeneratedAt() {
        return generatedAt;
    }
}
