# Whatnot fixtures

Shapes and id formats follow the saved OpenAPI spec (`docs/marketplaces/whatnot-api/openapi.json`,
Seller API v2): numeric string ids for products, orders and order items, `Money` as
`{ amount: "14.00", currency: "USD" }`, pages as `{ data, next_cursor }`, 207 batch results for
`PATCH /products/{id}/variants` and `POST /inventory/set`, and the only documented error body
(`HTTPValidationError`, for 422). Values are made up and have not come from a live Whatnot shop;
replace them with real responses (tokens removed) once the live checks in
`docs/marketplaces/whatnot.md` are done.
