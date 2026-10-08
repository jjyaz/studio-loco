export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_error: string | null
          last_ok_at: string | null
          p256dh: string
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_error?: string | null
          last_ok_at?: string | null
          p256dh: string
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_error?: string | null
          last_ok_at?: string | null
          p256dh?: string
          user_id?: string
        }
        Relationships: []
      }
      recorder_records: {
        Row: {
          id: string
          record: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          id: string
          record: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          id?: string
          record?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      signal_alerts: {
        Row: {
          created_at: string
          dedupe_key: string
          id: string
          payload: Json
          push_status: string | null
          read_at: string | null
          reason: string
          revision: number
          trigger: string
          user_id: string
          watch_id: string | null
          watch_kind: string
        }
        Insert: {
          created_at?: string
          dedupe_key: string
          id?: string
          payload?: Json
          push_status?: string | null
          read_at?: string | null
          reason: string
          revision: number
          trigger: string
          user_id: string
          watch_id?: string | null
          watch_kind: string
        }
        Update: {
          created_at?: string
          dedupe_key?: string
          id?: string
          payload?: Json
          push_status?: string | null
          read_at?: string | null
          reason?: string
          revision?: number
          trigger?: string
          user_id?: string
          watch_id?: string | null
          watch_kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "signal_alerts_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "signal_watches"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_observations: {
        Row: {
          error: string | null
          id: number
          observed_at: string
          ok: boolean
          revision: number
          summary: Json
          tick_id: number | null
          user_id: string
          watch_id: string
        }
        Insert: {
          error?: string | null
          id?: number
          observed_at?: string
          ok: boolean
          revision: number
          summary?: Json
          tick_id?: number | null
          user_id: string
          watch_id: string
        }
        Update: {
          error?: string | null
          id?: number
          observed_at?: string
          ok?: boolean
          revision?: number
          summary?: Json
          tick_id?: number | null
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "signal_observations_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "signal_watches"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_ticks: {
        Row: {
          alerts: number
          errors: number
          finished_at: string | null
          id: number
          note: string | null
          processed: number
          started_at: string
        }
        Insert: {
          alerts?: number
          errors?: number
          finished_at?: string | null
          id?: number
          note?: string | null
          processed?: number
          started_at?: string
        }
        Update: {
          alerts?: number
          errors?: number
          finished_at?: string | null
          id?: number
          note?: string | null
          processed?: number
          started_at?: string
        }
        Relationships: []
      }
      signal_watches: {
        Row: {
          cluster: string
          consecutive_errors: number
          created_at: string
          expires_at: string
          id: string
          kind: string
          label: string
          last_error: string | null
          last_ok_at: string | null
          last_proposed: Json
          last_run_at: string | null
          out_run: Json | null
          owner: string | null
          pool: string | null
          position: string | null
          revision: number
          rule: Json
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cluster?: string
          consecutive_errors?: number
          created_at?: string
          expires_at?: string
          id?: string
          kind: string
          label?: string
          last_error?: string | null
          last_ok_at?: string | null
          last_proposed?: Json
          last_run_at?: string | null
          out_run?: Json | null
          owner?: string | null
          pool?: string | null
          position?: string | null
          revision?: number
          rule: Json
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cluster?: string
          consecutive_errors?: number
          created_at?: string
          expires_at?: string
          id?: string
          kind?: string
          label?: string
          last_error?: string | null
          last_ok_at?: string | null
          last_proposed?: Json
          last_run_at?: string | null
          out_run?: Json | null
          owner?: string | null
          pool?: string | null
          position?: string | null
          revision?: number
          rule?: Json
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      signal_acquire_lease: {
        Args: { _holder: string; _ttl_seconds: number }
        Returns: boolean
      }
      signal_commit: {
        Args: {
          _alert: Json
          _error: string
          _last_proposed: Json
          _ok: boolean
          _out_run: Json
          _revision: number
          _summary: Json
          _tick: number
          _watch: string
        }
        Returns: Json
      }
      signal_release_lease: { Args: { _holder: string }; Returns: undefined }
      signal_verify_cron: { Args: { _token: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
