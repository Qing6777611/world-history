import HistoryAtlas from "./history-atlas";
import { localToday } from "./atlas-model";
export default function Home() { return <HistoryAtlas initialToday={localToday()} />; }
