// Minimal LL2 API response types — only the fields we consume.

export interface LL2Launch {
  id: string;
  name: string;               // "Falcon 9 Block 5 | USSF-317"
  status: { id: number; name: string; abbrev: string };
  net: string;                // ISO 8601
  window_start: string | null;
  window_end: string | null;
  launch_service_provider?: { id: number; name: string };
  rocket?: {
    configuration?: { id: number; name: string; full_name?: string };
  };
  mission?: { id: number; name?: string; description?: string; type?: string };
  pad?: { id: number; name: string; latitude?: string; longitude?: string };
}