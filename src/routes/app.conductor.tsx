import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Conductor } from "@/components/app/Conductor";
export const Route = createFileRoute("/app/conductor")({
  validateSearch: (s) =>
    z
      .object({
        mission: z
          .string()
          .regex(/^[a-z0-9-]{8,70}$/)
          .optional(),
        journey: z.string().max(150).optional(),
      })
      .catch({})
      .parse(s),
  head: () => ({
    meta: [
      { title: "The Conductor · Liquidity Missions — Studio Loco" },
      {
        name: "description",
        content:
          "Give Meteora liquidity a measurable mission. Real two-way quote probes, sealed policies, tracked inventory and Flight Recorder evidence.",
      },
    ],
  }),
  component: () => <Conductor initial={Route.useSearch()} />,
});
