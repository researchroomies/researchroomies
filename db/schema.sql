CREATE TABLE IF NOT EXISTS countries (
    id INTEGER NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    iso2 TEXT,
    iso3 TEXT
);

CREATE TABLE IF NOT EXISTS states (
    id INTEGER NOT NULL PRIMARY KEY,
    country_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    FOREIGN KEY (country_id) REFERENCES countries(id)
);

CREATE TABLE IF NOT EXISTS cities (
    id INTEGER NOT NULL PRIMARY KEY,
    country_id INTEGER,
    state_id INTEGER,
    name TEXT NOT NULL,
    FOREIGN KEY (country_id) REFERENCES countries(id),
    FOREIGN KEY (state_id) REFERENCES states(id)
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER NOT NULL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    created_at INTEGER
);

CREATE TABLE IF NOT EXISTS conferences (
    id INTEGER NOT NULL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    location_address TEXT,
    city_id INTEGER,
    start_time INTEGER NOT NULL,
    stop_time INTEGER NOT NULL,
    description TEXT,
    created_at INTEGER,
    is_featured INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (city_id) REFERENCES cities(id)
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER NOT NULL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    conference_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conference_id) REFERENCES conferences(id)
);

CREATE TABLE IF NOT EXISTS flags (
    id INTEGER NOT NULL PRIMARY KEY,
    post_id INTEGER NOT NULL,
    reason TEXT,
    flagged_by TEXT,
    timestamp INTEGER,
    FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS tags (
    slug TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conference_tags (
    tag_slug TEXT NOT NULL,
    conference_id INTEGER NOT NULL,
    PRIMARY KEY (tag_slug, conference_id),
    FOREIGN KEY (tag_slug) REFERENCES tags(slug),
    FOREIGN KEY (conference_id) REFERENCES conferences(id)
);

CREATE TABLE IF NOT EXISTS message (
    post_id NUMBER,
    sender_email STRING,
    recipient_email STRING,
    content STRING,
    timestamp NUMBER
);