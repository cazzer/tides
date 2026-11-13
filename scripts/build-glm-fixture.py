"""Build a GLM lightning fixture (tides-ufyr.13; format: src/glm.ts).

Writes the first N flashes of a real GLM L2 LCFA file to <out.nc>: every
flash_* variable on the number_of_flashes dimension cut to them, the other
flash_* variables (scalars) whole, and nominal_satellite_subpoint_lon, each
with its original attributes in their original order (_FillValue first, as
netCDF sets it at creation), packed raw (no scaling on the way through),
zlib + shuffle like the source. N = 0 gives the shape a quiet 20 s window
has.

The fixtures in src/__fixtures__ and their sources, from NOAA's open-data
buckets (read 2026-11-12); nothing at runtime reads them:
- glm-lcfa-g19-12.nc, glm-lcfa-g19-0.nc: noaa-goes19
  GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc
- glm-lcfa-g18-12.nc: noaa-goes18
  GLM-L2-LCFA/2026/316/22/OR_GLM-L2-LCFA_G18_s20263162200000_e20263162200200_c20263162200219.nc

Prints the fixture's flashes as netCDF4 itself unpacks them (its own mask
and scale, from the file's attributes, _Unsigned included: not
src/glm.ts's hard-coded GLM_PACKING, which the tests check against these),
as JSON, for the tests' expectations (<out>.json beside the .nc).

usage: uv run --no-project --with netCDF4 python -I scripts/build-glm-fixture.py <source.nc> <out.nc> [N] > <out.json>
"""

import json
import sys
from pathlib import Path

import netCDF4
import numpy as np

FLASH_DIM = "number_of_flashes"
# netCDF4 writes these itself.
SKIP_ATTRS = {"_FillValue", "DIMENSION_LIST", "_Netcdf4Coordinates", "_Netcdf4Dimid"}
FIELDS = {
    "firstS": "flash_time_offset_of_first_event",
    "lastS": "flash_time_offset_of_last_event",
    "energyJ": "flash_energy",
    "areaM2": "flash_area",
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
    # netCDF4's defaults: masked fill values, scale_factor / add_offset and
    # _Unsigned applied from the file's own attributes.
    values = {}
    for field, name in FIELDS.items():
        var = src.variables[name]
        var.set_auto_maskandscale(True)
        values[field] = np.ma.masked_invalid(np.ma.asarray(var[:n], dtype=np.float64))
    lat = np.asarray(src.variables["flash_lat"][:n], dtype=np.float64)
    lon = np.asarray(src.variables["flash_lon"][:n], dtype=np.float64)
    rows = []
    for i in range(n):
        if any(np.ma.is_masked(values[f][i]) for f in FIELDS):
            continue
        rows.append(
            {
                "lat": float(lat[i]),
                "lon": float(lon[i]),
                "firstS": float(values["firstS"][i]),
                "lastS": float(values["lastS"][i]),
                "energyJ": float(values["energyJ"][i]),
                "areaKm2": float(values["areaM2"][i]) / 1e6,
            }
        )
    return rows


def main() -> None:
    source = Path(sys.argv[1])
    out = Path(sys.argv[2])
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
    with netCDF4.Dataset(source) as src:
        copy(src, out, n)
        subpoint = float(src.variables["nominal_satellite_subpoint_lon"][...])
        print(json.dumps({"subpointLon": subpoint, "flashes": decode(src, n)}, indent=1))


if __name__ == "__main__":
    main()
