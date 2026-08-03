Your first task is to flesh out the SQLite target-get-many statement to allow many different filters recursively.

Here's some pseudocode:

```sqlite
WITH
  matches AS (
    SELECT
      m.destination,
      COUNT(*) AS match_count
    FROM
      metadata m
      INNER JOIN json_each('{ "breadcrumb": "Pretty" }') j ON j.key = m.label
      AND (
        j.value = m.value
        OR (
          json_valid(m.value)
          AND (
            (
              json_type(m.value) = 'array'
              AND EXISTS (
                SELECT
                  1
                FROM
                  json_each(m.value)
                WHERE
                  value = j.value
              )
              OR (
                json_type(j.value) = 'object'
                AND EXISTS (
                  SELECT
                    *
                  FROM
                    json.each (j.value)
                )
              )
            )
          )
        )
      )
    GROUP BY
      m.destination
  ),
  filter_count AS (
    SELECT
      COUNT(*) AS total
    FROM
      json_each('{ "breadcrumb": "Pretty" }')
  )
SELECT
  d.*,
  json_group_object(i.label, i.value) AS metadata
FROM
  destinations d
  INNER JOIN metadata i ON d.path = i.destination
  LEFT JOIN matches ON matches.destination = d.path
  CROSS JOIN filter_count f
WHERE
  (
    f.total = 0
    OR matches.match_count = f.total
  );
```

The full logic should allow for a filter like this:

```
{
  "status": "published",    // Exact match
  "deletedAt": null,    // Doesn't have this property
  "views": {
    ">": 1000  // Greater than
  },
  "author": {
        "|": [ // Or
            {
                "country": "Canada" // Property could be nested (author.country) or linked from the author property
            },
            {
                "country: "USA"
            },
            {
                "!": {  // Not
                    "theme": "Summer"
                }
            }
        ]
    }
}
```

All of the logic should be in one or two prepared SQLite statements. You should NOT prepare a new statement for every query. Use conditional and recursive logic in SQLite to make this work. If you can't do this, do not implement by preparing new statements for every query. Instead, explain why this is impossible. Then fact-check yourself, test your assumptions. Then tell me if your assumptions were correct.