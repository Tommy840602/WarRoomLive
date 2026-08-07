package com.warroomlive.attachments;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

public interface AttachmentJpaRepository extends JpaRepository<AttachmentEntity, Long> {

    /** One page of a room's files, newest first — see the recordings repository for why this is native. */
    @Query(value = "SELECT * FROM attachments WHERE room = :room "
            + "ORDER BY uploaded_at DESC, id DESC LIMIT :limit OFFSET :offset",
            nativeQuery = true)
    List<AttachmentEntity> pageForRoom(@Param("room") String room,
            @Param("limit") int limit, @Param("offset") int offset);

    Optional<AttachmentEntity> findByObjectKey(String objectKey);

    /** Retention candidates, oldest first and bounded. */
    List<AttachmentEntity> findByUploadedAtBeforeOrderByUploadedAtAsc(Instant cutoff, Limit limit);
}
