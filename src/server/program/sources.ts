/**
 * The enrolment source every template is born with.
 *
 * Its own module so the program services can share it without importing each other: the stamp
 * service, the points service and the named-source service all need these two strings, and a cycle
 * between them would be resolved by whichever file node happened to load first.
 *
 * Since owner decision **B7 option 3** the `direct` link's token is a **server-side attribution
 * record**. Nothing publishes it, no public route accepts it, and counter enrolment resolves it
 * from the staff member's own membership.
 */

/** Display name of the automatic source. Unique per template (`@@unique([templateId, name])`). */
export const DIRECT_SOURCE_NAME = "Direct";

/** `utmSource` value of the automatic source. Several named links may share a utmSource; this one is reserved. */
export const DIRECT_UTM_SOURCE = "direct";
