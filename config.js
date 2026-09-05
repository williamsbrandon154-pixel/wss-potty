// Supabase connection for the Potty Tracker. The anon key is a public key by design
// (row-level security on the database is what protects the data; users must sign in).
window.WSS_CONFIG = {
  supabaseUrl: "https://ngosolqoxngakpwmeqsg.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5nb3NvbHFveG5nYWtwd21lcXNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NzU4MDUsImV4cCI6MjEwNDE1MTgwNX0.J4RaVGUDv9xRfkVBhcEG7WbNywKxyz_S3WLj6-7Z6zY",
  appUrl: "" // empty = use whatever address the app is served from
};
