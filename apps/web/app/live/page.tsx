import { PATIO_DEFAULTS } from "@patio/config";

import { PatioHome } from "../../components/patio-home";
import { patioNetworkRuntimeConfigs } from "../../lib/network-runtime";

export default function TuneInPage() {
  const stationFrequency =
    process.env.PATIO_STATION_FREQUENCY ?? PATIO_DEFAULTS.stationFrequency;

  return (
    <PatioHome
      networkConfigs={patioNetworkRuntimeConfigs()}
      stationFrequency={stationFrequency}
    />
  );
}
