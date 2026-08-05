package com.warroomlive.signaling;

/**
 * Public identity of a peer as seen by others in a room.
 *
 * @param id   stable peer id (client-generated UUID)
 * @param name human-readable display name chosen on join
 */
public record PeerInfo(String id, String name) {
}
