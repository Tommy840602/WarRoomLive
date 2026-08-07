package com.warroomlive.attachments;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

/**
 * A file shared into a room.
 *
 * <p>Only the object key is kept, for the same reason recordings keep only
 * theirs: downloads are presigned per request, so a link cannot outlive the
 * access it was granted and the store's credentials never reach a browser.
 */
@Entity
@Table(name = "attachments")
public class AttachmentEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String room;

    /** Unique, so a replayed confirmation cannot list the same object twice. */
    @Column(name = "object_key", nullable = false, unique = true)
    private String objectKey;

    @Column(nullable = false)
    private String filename;

    @Column(name = "content_type", nullable = false)
    private String contentType;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    /** Authenticated subject when there is one, otherwise {@code anonymous}. */
    @Column(name = "uploaded_by", nullable = false)
    private String uploadedBy;

    @Column(name = "uploaded_at", nullable = false)
    private Instant uploadedAt;

    protected AttachmentEntity() {
    }

    public AttachmentEntity(String room, String objectKey, String filename, String contentType,
            long sizeBytes, String uploadedBy) {
        this.room = room;
        this.objectKey = objectKey;
        this.filename = filename;
        this.contentType = contentType;
        this.sizeBytes = sizeBytes;
        this.uploadedBy = uploadedBy;
        this.uploadedAt = Instant.now();
    }

    public Long getId() {
        return id;
    }

    public String getRoom() {
        return room;
    }

    public String getObjectKey() {
        return objectKey;
    }

    public String getFilename() {
        return filename;
    }

    public String getContentType() {
        return contentType;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public String getUploadedBy() {
        return uploadedBy;
    }

    public Instant getUploadedAt() {
        return uploadedAt;
    }
}
