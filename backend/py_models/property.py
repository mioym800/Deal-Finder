from pydantic import BaseModel, Field
from typing import Optional

class PropertyCard(BaseModel):
    address: str
    city: Optional[str] = None
    state: Optional[str] = None
    zip: Optional[str] = None
    listing_price: Optional[float] = Field(None, description="Numeric USD price")
    beds: Optional[float] = None
    baths: Optional[float] = None
    sqft: Optional[int] = None
    realtor_name: Optional[str] = None
    realtor_phone: Optional[str] = None
    realtor_email: Optional[str] = None
    source_url: Optional[str] = None
