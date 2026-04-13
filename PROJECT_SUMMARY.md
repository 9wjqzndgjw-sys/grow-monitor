# Grow Monitor Project Summary

## Overview
A web application for real-time monitoring of indoor gardening conditions (Temperature, Humidity, and Vapor Pressure Deficit - VPD). It integrates with **Hubitat** sensors via webhooks and stores data in **Supabase**.

## Technical Stack
- **Frontend**: React 19 (TypeScript), Vite, Recharts, Plain CSS.
- **Backend/API**: Vercel Serverless Functions (`api/`).
- **Database**: Supabase (PostgreSQL) with Row Level Security (RLS).
- **Integration**: Hubitat (incoming sensor webhooks).

## Core Features
- **Webhook Endpoint**: `api/hubitat-webhook.ts` receives sensor data and automatically maintains the `devices` lookup table via upserts.
- **VPD Calculation**: `src/lib/vpd.ts` calculates VPD from temperature and humidity.
- **Dashboard**: `src/pages/GrowDashboard.tsx` provides high-level metrics and visual charts.
    - **Metrics**: Displays current and average values for Temp, Humidity, and VPD.
    - **Export**: Built-in CSV export for raw sensor data in the selected time range.
    - **Optimized**: Uses the `devices` table for the device selector and handles data fetching with loading states/cleanup.
    - **Health Zones**: Visual indicators (color bands) for plant stress/ideal conditions.

## Key Files
- `api/hubitat-webhook.ts`: Handles incoming sensor data from Hubitat.
- `api/cron/downsample.ts`: (Likely) manages data aggregation for long-term storage.
- `src/pages/GrowDashboard.tsx`: Main UI for viewing current and historical data.
- `src/lib/vpd.ts`: Contains the VPD calculation formula and health zone definitions.
- `supabase/migrations/`: Database schema definitions for `devices` and `sensor_readings`.

## Notes
- The project follows a clean architecture with clear separation between data ingestion (API), storage (Supabase), and visualization (React).
- RLS is enabled on Supabase, allowing public (anon) read-only access to sensor data while restricting writes to service roles.
