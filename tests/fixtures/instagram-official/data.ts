// Invented Graph API and webhook fixtures; never use real accounts or tokens.
export const self = "1000", peer = "2000";
export const conversation = {
  id: "thread-a", participants: { data: [{ id: self, username: "excerlock" }, { id: peer, username: "Alice" }] },
};
export function message(id: string, created_time = "2026-10-12T10:00:00Z", outgoing = false) {
  return { id, created_time, from: { id: outgoing ? self : peer }, to: { data: [{ id: outgoing ? peer : self }] }, message: outgoing ? "Phone reply" : "Hello", attachments: { data: [{ image_data: { url: "https://example.invalid/image.jpg" } }] } };
}
export function webhook(id = "phone-echo", outgoing = true) {
  return { object: "instagram", entry: [{ id: self, messaging: [{ sender: { id: outgoing ? self : peer }, recipient: { id: outgoing ? peer : self }, timestamp: Date.parse("2026-10-12T10:00:00Z"), message: { mid: id, text: outgoing ? "Phone reply" : "Hello", is_echo: outgoing } }] }] };
}
