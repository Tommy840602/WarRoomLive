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
 * One thing somebody said, as speech recognition finally settled it.
 *
 * <p>Only final utterances become rows. Recognition emits a running guess that
 * is replaced several times a second; those are relayed to the room and
 * forgotten, the same treatment awareness gets on the CRDT plane. Storing them
 * would fill the table with sentences nobody ever finished saying.
 *
 * <p>The translation is nullable and set later, or never. A subtitle that waited
 * for a language model would not be a subtitle, so the line is committed and
 * broadcast the moment it is final and the translation catches up — or does not,
 * when no translator is configured, which is the default.
 */
@Entity
@Table(name = "transcript_lines")
public class TranscriptLineEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    @Column(name = "peer_id", nullable = false)
    private String peerId;

    /**
     * The display name at the time of speaking, copied rather than joined.
     * A year later the peer id means nothing to anyone, and the person may not
     * be in any table this could join to.
     */
    @Column(nullable = false)
    private String speaker;

    /** BCP-47 as the browser reported it, e.g. {@code cmn-Hant-TW} or {@code en-US}. */
    @Column(nullable = false, length = 35)
    private String lang;

    @Column(nullable = false, length = 4000)
    private String text;

    @Column(length = 4000)
    private String translation;

    @Column(name = "translation_lang", length = 35)
    private String translationLang;

    /** The speaker's clock, distinct from when the row was written. */
    @Column(name = "spoken_at", nullable = false)
    private Instant spokenAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected TranscriptLineEntity() {
    }

    public TranscriptLineEntity(String room, String peerId, String speaker, String lang,
            String text, Instant spokenAt) {
        this.room = room;
        this.peerId = peerId;
        this.speaker = speaker;
        this.lang = lang;
        this.text = text;
        // Truncated to what a timestamptz column actually keeps, so a line's
        // times do not change the first time it is read back from the database.
        this.spokenAt = spokenAt == null ? null : spokenAt.truncatedTo(ChronoUnit.MICROS);
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public void translated(String translation, String translationLang) {
        this.translation = translation;
        this.translationLang = translationLang;
    }

    public Long getId() {
        return id;
    }

    public String getRoom() {
        return room;
    }

    public String getPeerId() {
        return peerId;
    }

    public String getSpeaker() {
        return speaker;
    }

    public String getLang() {
        return lang;
    }

    public String getText() {
        return text;
    }

    public String getTranslation() {
        return translation;
    }

    public String getTranslationLang() {
        return translationLang;
    }

    public Instant getSpokenAt() {
        return spokenAt;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
