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
      depot_agents: {
        Row: {
          created_at: string
          description: string
          gate_max_age_s: number
          gate_min_raw: string | null
          gate_mint: string | null
          id: string
          launch: Json | null
          mission: string
          name: string
          published_at: string | null
          report_policy: string
          revision: number
          updated_at: string
          user_id: string
          visibility: string
          wallet: string | null
          wallet_verified_at: string | null
        }
        Insert: {
          created_at?: string
          description?: string
          gate_max_age_s?: number
          gate_min_raw?: string | null
          gate_mint?: string | null
          id?: string
          launch?: Json | null
          mission?: string
          name: string
          published_at?: string | null
          report_policy?: string
          revision?: number
          updated_at?: string
          user_id: string
          visibility?: string
          wallet?: string | null
          wallet_verified_at?: string | null
        }
        Update: {
          created_at?: string
          description?: string
          gate_max_age_s?: number
          gate_min_raw?: string | null
          gate_mint?: string | null
          id?: string
          launch?: Json | null
          mission?: string
          name?: string
          published_at?: string | null
          report_policy?: string
          revision?: number
          updated_at?: string
          user_id?: string
          visibility?: string
          wallet?: string | null
          wallet_verified_at?: string | null
        }
        Relationships: []
      }
      depot_images: {
        Row: {
          bytes: string
          created_at: string
          digest: string
          mime: string
          user_id: string
        }
        Insert: {
          bytes: string
          created_at?: string
          digest: string
          mime: string
          user_id: string
        }
        Update: {
          bytes?: string
          created_at?: string
          digest?: string
          mime?: string
          user_id?: string
        }
        Relationships: []
      }
      depot_metadata: {
        Row: {
          agent_id: string | null
          body: string
          digest: string
          image_digest: string
          published_at: string
          user_id: string
          version: number
        }
        Insert: {
          agent_id?: string | null
          body: string
          digest: string
          image_digest: string
          published_at?: string
          user_id: string
          version: number
        }
        Update: {
          agent_id?: string | null
          body?: string
          digest?: string
          image_digest?: string
          published_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "depot_metadata_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "depot_agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depot_metadata_image_digest_fkey"
            columns: ["image_digest"]
            isOneToOne: false
            referencedRelation: "depot_images"
            referencedColumns: ["digest"]
          },
        ]
      }
      depot_nonces: {
        Row: {
          agent_id: string
          consumed_at: string | null
          domain: string
          expires_at: string
          issued_at: string
          nonce: string
          purpose: string
          user_id: string
          wallet: string
        }
        Insert: {
          agent_id: string
          consumed_at?: string | null
          domain: string
          expires_at: string
          issued_at?: string
          nonce: string
          purpose: string
          user_id: string
          wallet: string
        }
        Update: {
          agent_id?: string
          consumed_at?: string | null
          domain?: string
          expires_at?: string
          issued_at?: string
          nonce?: string
          purpose?: string
          user_id?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "depot_nonces_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "depot_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      depot_reports: {
        Row: {
          agent_id: string
          ai: Json | null
          created_at: string
          facts: Json
          id: string
          observed_at: string
          pool: string
          slot: number
          user_id: string
        }
        Insert: {
          agent_id: string
          ai?: Json | null
          created_at?: string
          facts: Json
          id?: string
          observed_at: string
          pool: string
          slot: number
          user_id: string
        }
        Update: {
          agent_id?: string
          ai?: Json | null
          created_at?: string
          facts?: Json
          id?: string
          observed_at?: string
          pool?: string
          slot?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "depot_reports_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "depot_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      depot_viewer_wallets: {
        Row: {
          agent_id: string
          user_id: string
          verified_at: string
          wallet: string
        }
        Insert: {
          agent_id: string
          user_id: string
          verified_at?: string
          wallet: string
        }
        Update: {
          agent_id?: string
          user_id?: string
          verified_at?: string
          wallet?: string
        }
        Relationships: [
          {
            foreignKeyName: "depot_viewer_wallets_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "depot_agents"
            referencedColumns: ["id"]
          },
        ]
      }
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
      conductor_observer_change: {
        Args: {
          _action: string
          _revision: number
          _rule: Json
          _user: string
          _watch: string
        }
        Returns: Json
      }
      conductor_observer_commit: {
        Args: {
          _alert: Json
          _error: string
          _holder: string
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
      depot_consume_nonce: {
        Args: {
          _agent: string
          _domain: string
          _nonce: string
          _purpose: string
          _user: string
          _wallet: string
        }
        Returns: boolean
      }
      depot_holder_reports: {
        Args: {
          _agent: string
          _balance: string
          _mint: string
          _read_at: string
          _revision: number
          _user: string
          _wallet: string
        }
        Returns: Json
      }
      depot_link_launch: {
        Args: {
          _agent: string
          _digest: string
          _launch: Json
          _revision: number
          _user: string
          _wallet: string
        }
        Returns: Json
      }
      depot_public_image: {
        Args: { _digest: string }
        Returns: {
          b64: string
          mime: string
        }[]
      }
      depot_public_metadata: { Args: { _digest: string }; Returns: string }
      depot_public_passport: { Args: { _id: string }; Returns: Json }
      depot_public_reports: { Args: { _agent: string }; Returns: Json }
      depot_publish_metadata: {
        Args: {
          _agent: string
          _body: string
          _digest: string
          _image_digest: string
          _image_hex: string
          _image_mime: string
          _user: string
        }
        Returns: Json
      }
      signal_acquire_lease: {
        Args: { _holder: string; _ttl_seconds: number }
        Returns: boolean
      }
      signal_commit: {
        Args: {
          _alert: Json
          _error: string
          _holder: string
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
      signal_push_seed: { Args: never; Returns: string }
      signal_release_lease: { Args: { _holder: string }; Returns: undefined }
      signal_save_push: {
        Args: {
          _auth: string
          _endpoint: string
          _p256dh: string
          _user: string
        }
        Returns: string
      }
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
