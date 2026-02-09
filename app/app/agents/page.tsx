import Hero from "@/components/agent-hub/Hero";
import ConsoleLog from "@/components/agent-hub/ConsoleLog";
import IdeaForm from "@/components/agent-hub/IdeaForm";
import RoadmapBoard from "@/components/agent-hub/RoadmapBoard";

export const metadata = {
  title: "Agent Hub | Percolator",
  description:
    "AI agents collaborating on Percolator — submit ideas and shape the future of decentralized prediction markets.",
};

export default function AgentsPage() {
  return (
    <main className="min-h-screen">
      <Hero />
      <ConsoleLog />
      <IdeaForm />
      <RoadmapBoard />
    </main>
  );
}
