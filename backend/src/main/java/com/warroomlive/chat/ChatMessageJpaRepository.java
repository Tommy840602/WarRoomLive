package com.warroomlive.chat;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

/** Spring Data access to {@link ChatMessageEntity}; only instantiated under the {@code postgres} profile. */
public interface ChatMessageJpaRepository extends JpaRepository<ChatMessageEntity, Long> {

    /** Most recent messages for a room, newest first (caller reverses for chronological order). */
    List<ChatMessageEntity> findByRoomOrderByIdDesc(String room, Limit limit);
}
