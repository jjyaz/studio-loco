import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Switchyard } from "@/components/app/Switchyard";
const Search = z.object({
  experiment: z
    .string()
    .max(50)
    .regex(/^[a-z0-9][a-z0-9:._-]*$/)
    .optional(),
  journey: z.string().max(100).optional(),
});
export const Route = createFileRoute("/app/switchyard")({
  validateSearch: (input) => Search.catch({}).parse(input),
  head: () => ({
    meta: [
      { title: "The Switchyard · Live shadow strategies — Studio Loco" },
      {
        name: "description",
        content:
          "Compare a verified Meteora DLMM account with sealed prospective range policies. Point-observation scorecards, timestamped decisions and fresh Planner handoffs.",
      },
    ],
  }),
  component: () => <Switchyard initial={Route.useSearch()} />,
});
