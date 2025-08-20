import { Request, Response } from 'express';
import { City, Faculty, Department, Subject, Material } from '../models';

// Cities
export const getCities = async (req: Request, res: Response) => {
  try {
    const cities = await City.find().sort({ name: 1 });
    res.json({ success: true, cities });
  } catch (error) {
    console.error('Get cities error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createCity = async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'City name is required' });
    }

    const city = new City({ name: name.trim() });
    await city.save();
    
    res.status(201).json({ success: true, city });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'City name already exists' });
    }
    console.error('Create city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateCity = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'City name is required' });
    }

    const city = await City.findByIdAndUpdate(id, { name: name.trim() }, { new: true });
    if (!city) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    
    res.json({ success: true, city });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'City name already exists' });
    }
    console.error('Update city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteCity = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if city has faculties
    const facultyCount = await Faculty.countDocuments({ cityId: id });
    if (facultyCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete city with faculties. Please delete or move faculties first.' 
      });
    }

    const city = await City.findByIdAndDelete(id);
    if (!city) {
      return res.status(404).json({ success: false, message: 'City not found' });
    }
    
    res.json({ success: true, message: 'City deleted successfully' });
  } catch (error) {
    console.error('Delete city error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Faculties
export const getFaculties = async (req: Request, res: Response) => {
  try {
    const { cityId } = req.query;
    
    const query = cityId ? { cityId } : {};
    const faculties = await Faculty.find(query).populate('cityId', 'name').sort({ name: 1 });
    
    res.json({ success: true, faculties });
  } catch (error) {
    console.error('Get faculties error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createFaculty = async (req: Request, res: Response) => {
  try {
    const { name, cityId } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Faculty name is required' });
    }
    
    if (!cityId) {
      return res.status(400).json({ success: false, message: 'City ID is required' });
    }

    const faculty = new Faculty({ name: name.trim(), cityId });
    await faculty.save();
    await faculty.populate('cityId', 'name');
    
    res.status(201).json({ success: true, faculty });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Faculty name already exists in this city' });
    }
    console.error('Create faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const getFacultyById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const faculty = await Faculty.findById(id).populate('cityId', 'name');
    if (!faculty) {
      return res.status(404).json({ success: false, message: 'Faculty not found' });
    }
    
    res.json({ success: true, faculty });
  } catch (error) {
    console.error('Get faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteFaculty = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if faculty has departments
    const departmentCount = await Department.countDocuments({ facultyId: id });
    if (departmentCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete faculty with departments. Please delete departments first.' 
      });
    }

    const faculty = await Faculty.findByIdAndDelete(id);
    if (!faculty) {
      return res.status(404).json({ success: false, message: 'Faculty not found' });
    }
    
    res.json({ success: true, message: 'Faculty deleted successfully' });
  } catch (error) {
    console.error('Delete faculty error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Departments
export const getDepartments = async (req: Request, res: Response) => {
  try {
    const { facultyId } = req.query;
    
    if (!facultyId) {
      return res.status(400).json({ success: false, message: 'Faculty ID is required' });
    }
    
    const departments = await Department.find({ facultyId }).sort({ order: 1, name: 1 });
    
    res.json({ success: true, departments });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createDepartment = async (req: Request, res: Response) => {
  try {
    const { name, facultyId, availableYears = [1, 2, 3, 4] } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }
    
    if (!facultyId) {
      return res.status(400).json({ success: false, message: 'Faculty ID is required' });
    }

    const department = new Department({ 
      name: name.trim(), 
      facultyId,
      availableYears: availableYears.sort((a: number, b: number) => a - b)
    });
    await department.save();
    
    res.status(201).json({ success: true, department });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Department name already exists in this faculty' });
    }
    console.error('Create department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const updateDepartment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, availableYears } = req.body;
    
    const updateData: any = {};
    if (name && name.trim()) {
      updateData.name = name.trim();
    }
    if (availableYears) {
      updateData.availableYears = availableYears.sort((a: number, b: number) => a - b);
    }

    const department = await Department.findByIdAndUpdate(id, updateData, { new: true });
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }
    
    res.json({ success: true, department });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Department name already exists in this faculty' });
    }
    console.error('Update department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteDepartment = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if department has subjects
    const subjectCount = await Subject.countDocuments({ departmentId: id });
    if (subjectCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete department with subjects. Please delete subjects first.' 
      });
    }

    const department = await Department.findByIdAndDelete(id);
    if (!department) {
      return res.status(404).json({ success: false, message: 'Department not found' });
    }
    
    res.json({ success: true, message: 'Department deleted successfully' });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// Subjects
export const getSubjects = async (req: Request, res: Response) => {
  try {
    const { facultyId, departmentId, year } = req.query;
    
    const query: any = {};
    if (facultyId) query.facultyId = facultyId;
    if (departmentId) query.departmentId = departmentId;
    if (year) query.year = parseInt(year as string);
    
    const subjects = await Subject.find(query)
      .populate('departmentId', 'name')
      .sort({ order: 1, name: 1 });
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const createSubject = async (req: Request, res: Response) => {
  try {
    const { name, facultyId, departmentId, year } = req.body;
    
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Subject name is required' });
    }
    
    if (!facultyId || !departmentId || !year) {
      return res.status(400).json({ success: false, message: 'Faculty ID, Department ID, and Year are required' });
    }

    const subject = new Subject({ 
      name: name.trim(), 
      facultyId,
      departmentId,
      year: parseInt(year)
    });
    await subject.save();
    await subject.populate('departmentId', 'name');
    
    res.status(201).json({ success: true, subject });
  } catch (error: any) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Subject name already exists for this department and year' });
    }
    console.error('Create subject error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

export const deleteSubject = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if subject has materials
    const materialCount = await Material.countDocuments({ subjectId: id });
    if (materialCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete subject with materials. Please delete materials first.' 
      });
    }

    const subject = await Subject.findByIdAndDelete(id);
    if (!subject) {
      return res.status(404).json({ success: false, message: 'Subject not found' });
    }
    
    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Delete subject error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};