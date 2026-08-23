# Telegram profile avatar

## Contract requirements

- `TG-PROFILE-AVATAR-1.1` `PUT /sessions/:sessionId/profile/avatar` accepts a non-empty JPEG body for an initialized ready session and replaces the current account profile photo.
- `TG-PROFILE-AVATAR-1.2` Real mode writes the validated bytes to a service-owned temporary JPEG, invokes TDLib `setProfilePhoto` with `inputChatPhotoStatic` and `inputFileLocal`, and removes the temporary file afterward.
- `TG-PROFILE-AVATAR-1.3` `DELETE /sessions/:sessionId/profile/avatar` invokes TDLib `deleteProfilePhoto` for the current profile photo when one exists and succeeds as a no-op when none exists.
- `TG-PROFILE-AVATAR-1.4` Mock and real adapters expose the same replace/remove operations. Unknown or non-ready sessions and invalid bodies fail through the existing HTTP error boundary.

## Security boundary

The main backend proves ownership of the linked session. The TDLib service accepts image bytes, not an image URL, so it never performs a caller-directed network request. The body is limited to 5 MB and normalized to JPEG by the backend before it crosses this boundary.

## Executable coverage

`tests/profile-avatar.test.ts` verifies mock adapter replacement and removal. Real TDLib behavior is covered by the shared adapter contract and TypeScript compilation; it requires an authenticated Telegram runtime for an external smoke test.

