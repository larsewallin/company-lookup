-- Extract Overture Maps places for the presence-data pilot countries (lib/places.js), one NDJSON file set
-- per country under extract/cc=XX/. Run by .github/workflows/places-monthly.yml with OVERTURE_RELEASE set.
-- Kept: named places that are not permanently closed, outside geographic and cultural/historic categories.
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';
SET preserve_insertion_order = false;
COPY (
  SELECT
    id,
    names.primary AS name,
    addresses[1].country AS cc,
    addresses[1].freeform AS street,
    addresses[1].locality AS locality,
    addresses[1].postcode AS postcode,
    addresses[1].region AS region,
    round((bbox.xmin + bbox.xmax) / 2, 6) AS lon,
    round((bbox.ymin + bbox.ymax) / 2, 6) AS lat,
    coalesce(taxonomy.primary, basic_category) AS cat,
    round(confidence, 3) AS conf,
    list_distinct(list_transform(sources, s -> s.dataset || '|' || coalesce(s.license, ''))) AS src
  FROM read_parquet('s3://overturemaps-us-west-2/release/' || getenv('OVERTURE_RELEASE') || '/theme=places/type=place/*', hive_partitioning = 1)
  WHERE bbox.xmin BETWEEN -19 AND 18 AND bbox.ymin BETWEEN 27 AND 56
    AND addresses[1].country IN ('DE', 'IT', 'ES', 'NL', 'BE', 'AT')
    AND names.primary IS NOT NULL AND length(trim(names.primary)) >= 2
    AND coalesce(operating_status, '') <> 'permanently_closed'
    AND coalesce(taxonomy.hierarchy[1], '') NOT IN ('geographic_entities', 'cultural_and_historic')
) TO 'extract' (FORMAT json, PARTITION_BY (cc), OVERWRITE_OR_IGNORE true);
SELECT cc, count(*) FROM read_json('extract/*/*.json', hive_partitioning = 1) GROUP BY 1 ORDER BY 2 DESC;
