-- One-off look at the Overture places schema and row counts for the pilot countries.
INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';
CREATE VIEW p AS SELECT * FROM read_parquet('s3://overturemaps-us-west-2/release/' || getenv('OVERTURE_RELEASE') || '/theme=places/type=place/*', hive_partitioning=1);
DESCRIBE p;
SELECT addresses[1].country AS cc, count(*) AS n FROM p
 WHERE bbox.xmin BETWEEN -10 AND 20 AND bbox.ymin BETWEEN 35 AND 56 AND addresses[1].country IN ('DE','IT','ES','NL','BE','AT')
 GROUP BY 1 ORDER BY 2 DESC;
SELECT taxonomy.hierarchy[1] AS top, count(*) AS n FROM p
 WHERE bbox.xmin BETWEEN 9.5 AND 10.5 AND bbox.ymin BETWEEN 53 AND 54 GROUP BY 1 ORDER BY 2 DESC;
SELECT operating_status, count(*) n FROM p WHERE bbox.xmin BETWEEN 9.5 AND 10.5 AND bbox.ymin BETWEEN 53 AND 54 GROUP BY 1;
SELECT width_bucket(confidence, 0, 1, 10) AS conf_decile, count(*) n FROM p WHERE bbox.xmin BETWEEN 9.5 AND 10.5 AND bbox.ymin BETWEEN 53 AND 54 GROUP BY 1 ORDER BY 1;
SELECT id, names.primary, basic_category, taxonomy.primary, confidence, addresses[1] FROM p WHERE bbox.xmin BETWEEN 9.9 AND 10.0 AND bbox.ymin BETWEEN 53.5 AND 53.6 LIMIT 5;
