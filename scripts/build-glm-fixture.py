"""Build the GLM lightning fixtures (tides-ufyr.13; format: src/glm.ts).

- src/__fixtures__/glm-lcfa-g19-12.nc: the first N (12) flashes of a real
  GOES-19 GLM L2 LCFA file: every flash_* variable on the number_of_flashes
  dimension cut to them, the other flash_* variables (scalars) whole, and
  nominal_satellite_subpoint_lon, each with its original attributes in
  their original order (_FillValue first, as netCDF sets it at creation),
  packed raw (no scaling on the way through), zlib + shuffle like the
  source.
- src/__fixtures__/glm-lcfa-g19-0.nc: the same with no flashes, the shape
  a quiet 20 s window has.

Source: NOAA's open-data bucket noaa-goes19,
GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc
(read 2026-11-12). Nothing at runtime reads it.

Prints the fixture's flashes decoded with the packing src/glm.ts hard-codes
(GLM_PACKING), as JSON, for the tests' expectations
(src/__fixtures__/glm-lcfa-g19-12.json).

usage: uv run --no-project --with netCDF4 python -I scripts/build-glm-fixture.py <source.nc> <out_dir> [N] > src/__fixtures__/glm-lcfa-g19-12.json
"""

import json
import sys
from pathlib import Path

import netCDF4
import numpy as np

FLASH_DIM = "number_of_flashes"
# netCDF4 writes these itself.
SKIP_ATTRS = {"_FillValue", "DIMENSION_LIST", "_Netcdf4Coordinates", "_Netcdf4Dimid"}
# src/glm.ts GLM_PACKING.
TIME = (0.00038147560553625226, -5.0)
PACKING = {
    "flash_time_offset_of_first_event": TIME,
    "flash_time_offset_of_last_event": TIME,
    "flash_energy": (9.999959802209943e-16, 2.8514998886357517e-16),
    "flash_area": (152601.859375, 0.0),
}


def copy(src: netCDF4.Dataset, out: Path, n: int) -> None:
    with netCDF4.Dataset(out, "w", format="NETCDF4") as dst:
        dst.createDimension(FLASH_DIM, n)
        names = [k for k in src.variables if k.startswith("flash_")] + ["nominal_satellite_subpoint_lon"]
        for name in names:
            var = src.variables[name]
            var.set_auto_maskandscale(False)
            dims = var.dimensions
            if dims and dims != (FLASH_DIM,):
                continue
            fill = var.getncattr("_FillValue") if "_FillValue" in var.ncattrs() else None
            v = dst.createVariable(name, var.dtype, dims, zlib=True, shuffle=True, fill_value=fill)
            v.set_auto_maskandscale(False)
            for attr in var.ncattrs():
                if attr not in SKIP_ATTRS:
                    v.setncattr(attr, var.getncattr(attr))
            v[...] = var[:n] if dims else var[...]


def decode(src: netCDF4.Dataset, n: int) -> list[dict]:
    raw = {}
    for name in PACKING:
        var = src.variables[name]
        var.set_auto_maskandscale(False)
        raw[name] = np.asarray(var[:n]).astype(np.int64)
    lat = np.asarray(src.variables["flash_lat"][:n], dtype=np.float64)
    lon = np.asarray(src.variables["flash_lon"][:n], dtype=np.float64)
    rows = []
    for i in range(n):
        if any(raw[k][i] == -1 for k in PACKING):
            continue
        value = {k: float((raw[k][i] & 0xFFFF) * s + o) for k, (s, o) in PACKING.items()}
        rows.append(
            {
                "lat": float(np.float32(lat[i])),
                "lon": float(np.float32(lon[i])),
                "firstS": value["flash_time_offset_of_first_event"],
                "lastS": value["flash_time_offset_of_last_event"],
                "energyJ": value["flash_energy"],
                "areaKm2": value["flash_area"] / 1e6,
            }
        )
    return rows


def main() -> None:
    source = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    with netCDF4.Dataset(source) as src:
        copy(src, out_dir / f"glm-lcfa-g19-{n}.nc", n)
        copy(src, out_dir / "glm-lcfa-g19-0.nc", 0)
        print(json.dumps({"subpointLon": float(src.variables["nominal_satellite_subpoint_lon"][...]), "flashes": decode(src, n)}, indent=1))


if __name__ == "__main__":
    main()
