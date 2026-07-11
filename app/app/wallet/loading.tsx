import { PageSkeleton } from "@/components/ui/PageSkeleton";

export default function Loading() {
  return <PageSkeleton titleWidth="w-36" subtitleWidth="w-72" cards={4} maxWidth="max-w-5xl" />;
}
