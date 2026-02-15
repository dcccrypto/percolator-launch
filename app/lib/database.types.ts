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
    PostgrestVersion: "14.1"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      bug_reports: {
        Row: {
          actual_behavior: string | null
          admin_notes: string | null
          bounty_wallet: string | null
          browser: string | null
          created_at: string | null
          description: string
          expected_behavior: string | null
          id: string
          ip: string | null
          page: string | null
          page_url: string | null
          severity: string
          status: string
          steps_to_reproduce: string | null
          title: string
          transaction_wallet: string | null
          twitter_handle: string
          updated_at: string | null
        }
        Insert: {
          actual_behavior?: string | null
          admin_notes?: string | null
          bounty_wallet?: string | null
          browser?: string | null
          created_at?: string | null
          description: string
          expected_behavior?: string | null
          id?: string
          ip?: string | null
          page?: string | null
          page_url?: string | null
          severity?: string
          status?: string
          steps_to_reproduce?: string | null
          title: string
          transaction_wallet?: string | null
          twitter_handle: string
          updated_at?: string | null
        }
        Update: {
          actual_behavior?: string | null
          admin_notes?: string | null
          bounty_wallet?: string | null
          browser?: string | null
          created_at?: string | null
          description?: string
          expected_behavior?: string | null
          id?: string
          ip?: string | null
          page?: string | null
          page_url?: string | null
          severity?: string
          status?: string
          steps_to_reproduce?: string | null
          title?: string
          transaction_wallet?: string | null
          twitter_handle?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      funding_history: {
        Row: {
          funding_index_qpb_e6: string
          id: number
          market_slab: string
          net_lp_pos: number
          price_e6: number
          rate_bps_per_slot: number
          slot: number
          timestamp: string
        }
        Insert: {
          funding_index_qpb_e6?: string
          id?: number
          market_slab: string
          net_lp_pos?: number
          price_e6?: number
          rate_bps_per_slot?: number
          slot: number
          timestamp?: string
        }
        Update: {
          funding_index_qpb_e6?: string
          id?: number
          market_slab?: string
          net_lp_pos?: number
          price_e6?: number
          rate_bps_per_slot?: number
          slot?: number
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "funding_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "insurance_fund_health"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "funding_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "market_stats"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "funding_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "oi_imbalance"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      insurance_history: {
        Row: {
          balance: number
          fee_revenue: number
          id: number
          market_slab: string
          slot: number
          timestamp: string
        }
        Insert: {
          balance: number
          fee_revenue: number
          id?: number
          market_slab: string
          slot: number
          timestamp?: string
        }
        Update: {
          balance?: number
          fee_revenue?: number
          id?: number
          market_slab?: string
          slot?: number
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "insurance_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "insurance_fund_health"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "insurance_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "market_stats"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "insurance_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "oi_imbalance"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      job_applications: {
        Row: {
          about: string
          availability: string
          created_at: string | null
          cv_data: string | null
          cv_filename: string | null
          desired_role: string
          discord: string | null
          email: string
          experience_level: string
          id: string
          name: string
          portfolio_links: string | null
          solana_wallet: string | null
          status: string | null
          telegram: string | null
          twitter_handle: string
        }
        Insert: {
          about: string
          availability: string
          created_at?: string | null
          cv_data?: string | null
          cv_filename?: string | null
          desired_role: string
          discord?: string | null
          email: string
          experience_level: string
          id?: string
          name: string
          portfolio_links?: string | null
          solana_wallet?: string | null
          status?: string | null
          telegram?: string | null
          twitter_handle: string
        }
        Update: {
          about?: string
          availability?: string
          created_at?: string | null
          cv_data?: string | null
          cv_filename?: string | null
          desired_role?: string
          discord?: string | null
          email?: string
          experience_level?: string
          id?: string
          name?: string
          portfolio_links?: string | null
          solana_wallet?: string | null
          status?: string | null
          telegram?: string | null
          twitter_handle?: string
        }
        Relationships: []
      }
      market_stats: {
        Row: {
          c_tot: number | null
          funding_rate: number | null
          index_price: number | null
          insurance_balance: number | null
          insurance_fee_revenue: number | null
          insurance_fund: number | null
          last_crank_slot: number | null
          last_price: number | null
          lifetime_force_closes: number | null
          lifetime_liquidations: number | null
          liquidation_buffer_bps: number | null
          liquidation_fee_bps: number | null
          liquidation_fee_cap: string | null
          lp_max_abs: number | null
          lp_sum_abs: number | null
          maintenance_fee_per_slot: string | null
          mark_price: number | null
          max_crank_staleness_slots: number | null
          net_lp_pos: number | null
          open_interest_long: number | null
          open_interest_short: number | null
          pnl_pos_tot: number | null
          slab_address: string
          total_accounts: number | null
          total_open_interest: number | null
          updated_at: string | null
          vault_balance: number | null
          volume_24h: number | null
          volume_total: number | null
          warmup_period_slots: number | null
        }
        Insert: {
          c_tot?: number | null
          funding_rate?: number | null
          index_price?: number | null
          insurance_balance?: number | null
          insurance_fee_revenue?: number | null
          insurance_fund?: number | null
          last_crank_slot?: number | null
          last_price?: number | null
          lifetime_force_closes?: number | null
          lifetime_liquidations?: number | null
          liquidation_buffer_bps?: number | null
          liquidation_fee_bps?: number | null
          liquidation_fee_cap?: string | null
          lp_max_abs?: number | null
          lp_sum_abs?: number | null
          maintenance_fee_per_slot?: string | null
          mark_price?: number | null
          max_crank_staleness_slots?: number | null
          net_lp_pos?: number | null
          open_interest_long?: number | null
          open_interest_short?: number | null
          pnl_pos_tot?: number | null
          slab_address: string
          total_accounts?: number | null
          total_open_interest?: number | null
          updated_at?: string | null
          vault_balance?: number | null
          volume_24h?: number | null
          volume_total?: number | null
          warmup_period_slots?: number | null
        }
        Update: {
          c_tot?: number | null
          funding_rate?: number | null
          index_price?: number | null
          insurance_balance?: number | null
          insurance_fee_revenue?: number | null
          insurance_fund?: number | null
          last_crank_slot?: number | null
          last_price?: number | null
          lifetime_force_closes?: number | null
          lifetime_liquidations?: number | null
          liquidation_buffer_bps?: number | null
          liquidation_fee_bps?: number | null
          liquidation_fee_cap?: string | null
          lp_max_abs?: number | null
          lp_sum_abs?: number | null
          maintenance_fee_per_slot?: string | null
          mark_price?: number | null
          max_crank_staleness_slots?: number | null
          net_lp_pos?: number | null
          open_interest_long?: number | null
          open_interest_short?: number | null
          pnl_pos_tot?: number | null
          slab_address?: string
          total_accounts?: number | null
          total_open_interest?: number | null
          updated_at?: string | null
          vault_balance?: number | null
          volume_24h?: number | null
          volume_total?: number | null
          warmup_period_slots?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets_with_stats"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      markets: {
        Row: {
          created_at: string | null
          decimals: number
          deployer: string
          id: string
          initial_price_e6: number | null
          lp_collateral: number | null
          matcher_context: string | null
          max_leverage: number
          mint_address: string
          name: string
          oracle_authority: string | null
          slab_address: string
          status: string
          symbol: string
          trading_fee_bps: number
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          decimals?: number
          deployer: string
          id?: string
          initial_price_e6?: number | null
          lp_collateral?: number | null
          matcher_context?: string | null
          max_leverage?: number
          mint_address: string
          name: string
          oracle_authority?: string | null
          slab_address: string
          status?: string
          symbol: string
          trading_fee_bps?: number
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          decimals?: number
          deployer?: string
          id?: string
          initial_price_e6?: number | null
          lp_collateral?: number | null
          matcher_context?: string | null
          max_leverage?: number
          mint_address?: string
          name?: string
          oracle_authority?: string | null
          slab_address?: string
          status?: string
          symbol?: string
          trading_fee_bps?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      oi_history: {
        Row: {
          id: number
          lp_max_abs: number
          lp_sum_abs: number
          market_slab: string
          net_lp_pos: number
          slot: number
          timestamp: string
          total_oi: number
        }
        Insert: {
          id?: number
          lp_max_abs: number
          lp_sum_abs: number
          market_slab: string
          net_lp_pos: number
          slot: number
          timestamp?: string
          total_oi: number
        }
        Update: {
          id?: number
          lp_max_abs?: number
          lp_sum_abs?: number
          market_slab?: string
          net_lp_pos?: number
          slot?: number
          timestamp?: string
          total_oi?: number
        }
        Relationships: [
          {
            foreignKeyName: "oi_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "insurance_fund_health"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "oi_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "market_stats"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "oi_history_market_slab_fkey"
            columns: ["market_slab"]
            isOneToOne: false
            referencedRelation: "oi_imbalance"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      oracle_prices: {
        Row: {
          created_at: string | null
          id: number
          price_e6: number
          slab_address: string
          timestamp: number
          tx_signature: string | null
        }
        Insert: {
          created_at?: string | null
          id?: number
          price_e6: number
          slab_address: string
          timestamp: number
          tx_signature?: string | null
        }
        Update: {
          created_at?: string | null
          id?: number
          price_e6?: number
          slab_address?: string
          timestamp?: number
          tx_signature?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "oracle_prices_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: false
            referencedRelation: "markets"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "oracle_prices_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: false
            referencedRelation: "markets_with_stats"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      simulation_price_history: {
        Row: {
          id: number
          session_id: number | null
          slab_address: string
          price_e6: number
          model: string
          timestamp: string
        }
        Insert: {
          id?: number
          session_id?: number | null
          slab_address: string
          price_e6: number
          model: string
          timestamp?: string
        }
        Update: {
          id?: number
          session_id?: number | null
          slab_address?: string
          price_e6?: number
          model?: string
          timestamp?: string
        }
        Relationships: [
          {
            foreignKeyName: "simulation_price_history_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "simulation_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      simulation_sessions: {
        Row: {
          id: number
          slab_address: string
          scenario: string | null
          model: string
          start_price_e6: number
          current_price_e6: number
          status: string
          updates_count: number | null
          started_at: string
          ended_at: string | null
          config: Json | null
          token_symbol: string | null
          token_name: string | null
          mint_address: string | null
          creator_wallet: string | null
          end_price_e6: number | null
          high_price_e6: number | null
          low_price_e6: number | null
          total_trades: number | null
          total_liquidations: number | null
          total_volume_e6: number | null
          force_closes: number | null
          peak_oi_e6: number | null
          final_funding_rate_e6: number | null
          final_insurance_balance_e6: number | null
          final_insurance_health_pct: number | null
          final_vault_balance_e6: number | null
          duration_seconds: number | null
          bot_count: number | null
          bots_data: Json | null
          share_image_url: string | null
        }
        Insert: {
          id?: number
          slab_address: string
          scenario?: string | null
          model: string
          start_price_e6: number
          current_price_e6: number
          status?: string
          updates_count?: number | null
          started_at?: string
          ended_at?: string | null
          config?: Json | null
          token_symbol?: string | null
          token_name?: string | null
          mint_address?: string | null
          creator_wallet?: string | null
          end_price_e6?: number | null
          high_price_e6?: number | null
          low_price_e6?: number | null
          total_trades?: number | null
          total_liquidations?: number | null
          total_volume_e6?: number | null
          force_closes?: number | null
          peak_oi_e6?: number | null
          final_funding_rate_e6?: number | null
          final_insurance_balance_e6?: number | null
          final_insurance_health_pct?: number | null
          final_vault_balance_e6?: number | null
          duration_seconds?: number | null
          bot_count?: number | null
          bots_data?: Json | null
          share_image_url?: string | null
        }
        Update: {
          id?: number
          slab_address?: string
          scenario?: string | null
          model?: string
          start_price_e6?: number
          current_price_e6?: number
          status?: string
          updates_count?: number | null
          started_at?: string
          ended_at?: string | null
          config?: Json | null
          token_symbol?: string | null
          token_name?: string | null
          mint_address?: string | null
          creator_wallet?: string | null
          end_price_e6?: number | null
          high_price_e6?: number | null
          low_price_e6?: number | null
          total_trades?: number | null
          total_liquidations?: number | null
          total_volume_e6?: number | null
          force_closes?: number | null
          peak_oi_e6?: number | null
          final_funding_rate_e6?: number | null
          final_insurance_balance_e6?: number | null
          final_insurance_health_pct?: number | null
          final_vault_balance_e6?: number | null
          duration_seconds?: number | null
          bot_count?: number | null
          bots_data?: Json | null
          share_image_url?: string | null
        }
        Relationships: []
      }
      trades: {
        Row: {
          created_at: string | null
          fee: number
          id: string
          price: number
          side: string
          size: number
          slab_address: string
          slot: number | null
          trader: string
          tx_signature: string | null
        }
        Insert: {
          created_at?: string | null
          fee?: number
          id?: string
          price: number
          side: string
          size: number
          slab_address: string
          slot?: number | null
          trader: string
          tx_signature?: string | null
        }
        Update: {
          created_at?: string | null
          fee?: number
          id?: string
          price?: number
          side?: string
          size?: number
          slab_address?: string
          slot?: number | null
          trader?: string
          tx_signature?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: false
            referencedRelation: "markets"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "trades_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: false
            referencedRelation: "markets_with_stats"
            referencedColumns: ["slab_address"]
          },
        ]
      }
    }
    Views: {
      insurance_fund_health: {
        Row: {
          fee_growth_24h: number | null
          health_ratio: number | null
          insurance_balance: number | null
          insurance_fee_revenue: number | null
          slab_address: string | null
          total_open_interest: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets_with_stats"
            referencedColumns: ["slab_address"]
          },
        ]
      }
      markets_with_stats: {
        Row: {
          c_tot: number | null
          created_at: string | null
          decimals: number | null
          deployer: string | null
          funding_rate: number | null
          id: string | null
          index_price: number | null
          initial_price_e6: number | null
          insurance_balance: number | null
          insurance_fee_revenue: number | null
          insurance_fund: number | null
          last_crank_slot: number | null
          last_price: number | null
          lifetime_force_closes: number | null
          lifetime_liquidations: number | null
          liquidation_buffer_bps: number | null
          liquidation_fee_bps: number | null
          liquidation_fee_cap: string | null
          lp_collateral: number | null
          lp_max_abs: number | null
          lp_sum_abs: number | null
          maintenance_fee_per_slot: string | null
          mark_price: number | null
          matcher_context: string | null
          max_crank_staleness_slots: number | null
          max_leverage: number | null
          mint_address: string | null
          name: string | null
          net_lp_pos: number | null
          open_interest_long: number | null
          open_interest_short: number | null
          oracle_authority: string | null
          pnl_pos_tot: number | null
          slab_address: string | null
          stats_updated_at: string | null
          status: string | null
          symbol: string | null
          total_accounts: number | null
          total_open_interest: number | null
          trading_fee_bps: number | null
          updated_at: string | null
          vault_balance: number | null
          volume_24h: number | null
          volume_total: number | null
          warmup_period_slots: number | null
        }
        Relationships: []
      }
      simulation_gallery: {
        Row: {
          id: number | null
          slab_address: string | null
          token_symbol: string | null
          token_name: string | null
          mint_address: string | null
          creator_wallet: string | null
          scenario: string | null
          model: string | null
          start_price_e6: number | null
          end_price_e6: number | null
          high_price_e6: number | null
          low_price_e6: number | null
          price_change_pct: number | null
          total_trades: number | null
          total_liquidations: number | null
          total_volume_e6: number | null
          force_closes: number | null
          peak_oi_e6: number | null
          final_funding_rate_e6: number | null
          final_insurance_balance_e6: number | null
          final_insurance_health_pct: number | null
          final_vault_balance_e6: number | null
          duration_seconds: number | null
          bot_count: number | null
          bots_data: Json | null
          share_image_url: string | null
          status: string | null
          started_at: string | null
          ended_at: string | null
          config: Json | null
        }
        Relationships: []
      }
      oi_imbalance: {
        Row: {
          imbalance_percent: number | null
          long_oi: number | null
          lp_max_abs: number | null
          lp_sum_abs: number | null
          net_lp_pos: number | null
          short_oi: number | null
          slab_address: string | null
          total_open_interest: number | null
        }
        Insert: {
          imbalance_percent?: never
          long_oi?: never
          lp_max_abs?: number | null
          lp_sum_abs?: number | null
          net_lp_pos?: number | null
          short_oi?: never
          slab_address?: string | null
          total_open_interest?: number | null
        }
        Update: {
          imbalance_percent?: never
          long_oi?: never
          lp_max_abs?: number | null
          lp_sum_abs?: number | null
          net_lp_pos?: number | null
          short_oi?: never
          slab_address?: string | null
          total_open_interest?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets"
            referencedColumns: ["slab_address"]
          },
          {
            foreignKeyName: "market_stats_slab_address_fkey"
            columns: ["slab_address"]
            isOneToOne: true
            referencedRelation: "markets_with_stats"
            referencedColumns: ["slab_address"]
          },
        ]
      }
    }
    Functions: {
      cleanup_old_history: {
        Args: { days_to_keep?: number }
        Returns: {
          insurance_deleted: number
          oi_deleted: number
        }[]
      }
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
